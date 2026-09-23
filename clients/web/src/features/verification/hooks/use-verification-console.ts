import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useSubmitVerification } from "@scvs/verify-api-client";
import type { SubmitRequestDto } from "@scvs/verify-api-client";
import { isApiBaseConfigured } from "@/lib/http";
import { defaultValues, evidenceFields, responseCopy } from "../constants";
import type {
  ConsoleFailure,
  ConsoleState,
  JobResponse,
  RecentJob,
  SourceUploadResponse,
  RejectedBuildOption,
  TargetType,
  VerifyFormValues,
  VerifyMode,
} from "../types";
import { copyValue } from "../utils/clipboard.util";
import { flowStepIndex, isFailedState } from "../utils/flow.util";
import { validateBuildOptions } from "../utils/build-options.util";
import { sourceSha256Refusal, sourceUriRefusal } from "../utils/evidence-rules.util";
import { buildInlineManifest, buildTarget } from "../utils/manifest.util";
import { rememberBuildLogToken } from "../utils/build-log-tokens.store";
import { rememberJob } from "../utils/recent-jobs.store";
import {
  chainSourceRefusal,
  sourceArchiveNotChainRecorded,
} from "../utils/source-archive.util";
import { bannerView, consoleStateToSubmissionState, submitRejection } from "../utils/result.util";
import { useJobEventStream } from "./use-job-event-stream";
import { useJobResultView } from "./use-job-result-view";
import { usePreflight } from "./use-preflight";
import { useRecentJobs } from "./use-recent-jobs";
import { useSourceArchive } from "./use-source-archive";
import { useTermsGate } from "./use-terms-gate";
import { evidencePrefill } from "../utils/evidence-prefill.util";

const MISSING_API_URL_DETAIL =
  "VITE_VERIFY_API_URL is not configured for this build.";

type UseVerificationConsoleOptions = {
  mode: VerifyMode;
  initialJobId?: string;
  forceNew?: boolean;
};

/**
 * Owns the submission state machine: submit a target, handle the `incomplete` round trip, follow the live job
 * stream, and record the result in this browser's recent-jobs list.
 */
export const useVerificationConsole = ({
  mode,
  initialJobId,
  forceNew = false,
}: UseVerificationConsoleOptions) => {
  const navigate = useNavigate();
  const form = useForm<VerifyFormValues>({
    defaultValues,
    mode: "onTouched",
  });
  const restoredJobRef = useRef<string | null>(null);
  const lastNotifiedRef = useRef<string | null>(null);

  const [targetType, setTargetType] = useState<TargetType>("contract_id");
  // One state, discriminated by which producer wrote it — see `ConsoleState` in ../types for why three
  // producers cannot share one flat object.
  const [consoleState, setConsoleState] = useState<ConsoleState>({ phase: "idle" });
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [rejectedOptions, setRejectedOptions] = useState<RejectedBuildOption[]>([]);
  const terms = useTermsGate();

  const recentJobs = useRecentJobs();
  const preflight = usePreflight(form);
  // Read fresh each render, so an archive picked after a re-run of preflight is judged against that run's
  // answer and never a previous contract's.
  const chainSourceField =
    preflight.state.phase === "answered"
      ? preflight.state.response.available_fields?.source_sha256
      : undefined;
  const chainSourceSha256 =
    typeof chainSourceField === "string" ? chainSourceField : undefined;
  const sourceArchive = useSourceArchive(form, chainSourceSha256);
  const submitMutation = useSubmitVerification();

  // `useWatch` rather than `form.watch()`: it returns a value instead of a function, which keeps this hook
  // memoizable.
  const watched = useWatch({ control: form.control });
  const values: VerifyFormValues = { ...defaultValues, ...watched };

  // The banner's fields, and the display status the copy table is keyed on.
  const banner = bannerView(consoleState);
  const submissionState = consoleStateToSubmissionState(consoleState);

  const rememberCurrentJob = (
    jobId: string,
    status: RecentJob["status"],
    nextResponse?: Partial<JobResponse>,
    /**
     * The job settled on this event. Only `onTerminal` passes it, and only the verifier's own `updated_at` is
     * stored — never this tab's clock, which is why it is not `|| now` like the field below.
     */
    options: { settled?: boolean } = {},
  ) => {
    const now = new Date().toISOString();
    rememberJob({
      job_id: jobId,
      status,
      target: nextResponse?.target || banner.target,
      detail: nextResponse?.detail || banner.detail,
      // Prefer the API-provided created_at (job submission time) when present; `rememberJob` preserves an
      // existing entry's own value over this one anyway.
      created_at: nextResponse?.created_at || now,
      // The verifier's own `updated_at` where the event carried one, and only otherwise this tab's clock.
      updated_at: nextResponse?.updated_at || now,
      ...(options.settled && nextResponse?.updated_at
        ? { finished_at: nextResponse.updated_at }
        : {}),
    });
  };

  const failWith = (failure: ConsoleFailure) => {
    setConsoleState({ phase: "failed", failure });
  };

  useEffect(() => {
    lastNotifiedRef.current = null;
  }, [activeJobId]);

  useJobEventStream(activeJobId, {
    onProgress: (data, detail) => {
      if (!activeJobId) return;
      rememberCurrentJob(activeJobId, data.status ?? "queued", {
        ...data,
        detail,
      });
      // Merging into the previous value is why a naive union over the old flat object could not work: the
      // stream sends partial updates.
      setConsoleState((prev) => ({
        phase: "job",
        state: "queued",
        response: {
          ...(prev.phase === "job" ? prev.response : {}),
          ...data,
          detail: detail || (prev.phase === "job" ? prev.response.detail : undefined),
        },
      }));
    },
    onTerminal: (terminal, data) => {
      if (!activeJobId) return;
      // Replaces rather than merges — a terminal event is the whole truth about the job.
      setConsoleState((prev) => ({
        phase: "job",
        state: terminal,
        response:
          data.created_at || prev.phase !== "job"
            ? data
            : { ...data, created_at: prev.response.created_at },
      }));
      rememberCurrentJob(activeJobId, terminal, data, { settled: true });

      // Guard against a duplicate delivery re-notifying for a state already announced.
      const notifyKey = `${activeJobId}:${terminal}`;
      if (lastNotifiedRef.current !== notifyKey) {
        lastNotifiedRef.current = notifyKey;
        if (terminal === "verified") toast.success("Verification passed");
        if (terminal === "mismatch") toast.error("Verification mismatch");
        if (terminal === "build_failed") toast.error("Build failed");
      }
    },
    onStreamFailure: (detail) => {
      if (!activeJobId) return;
      failWith({ code: "network_error", detail, job_id: activeJobId });
      rememberCurrentJob(activeJobId, "error", { detail });
      setActiveJobId(null);
    },
  });

  /** Opens an existing job; the stream above fills in the real state. */
  const restoreJob = (jobId: string) => {
    if (!isApiBaseConfigured()) {
      setConsoleState({
        phase: "failed",
        failure: { code: "missing_api_url", detail: MISSING_API_URL_DETAIL, job_id: jobId },
      });
      return;
    }

    // `submitting` until the stream's first event, which is what puts `ConsoleLoading` on screen.
    setConsoleState({ phase: "submitting" });
    setActiveJobId(jobId);
  };

  useEffect(() => {
    if (forceNew) {
      // This is "adjusting state when a prop changes".
      restoredJobRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConsoleState({ phase: "idle" });
      setActiveJobId(null);
      return;
    }

    const jobId = initialJobId;
    if (!jobId || mode !== "job" || restoredJobRef.current === jobId) {
      return;
    }
    restoredJobRef.current = jobId;
    restoreJob(jobId);
  }, [forceNew, initialJobId, mode]);

  /** Copies whatever the verifier already resolved into the evidence form. */
  const prefillEvidenceFields = (fields?: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(evidencePrefill(fields))) {
      form.setValue(key as keyof VerifyFormValues, value as string);
    }
  };

  const submitToApi = async (includeManifest: boolean) => {
    if (!isApiBaseConfigured()) {
      failWith({ code: "missing_api_url", detail: MISSING_API_URL_DETAIL });
      return;
    }

    // The gate is the absence of a call, not a disabled button.
    if (preflight.state.phase !== "answered" || preflight.state.verdict.gate !== "ready") {
      return;
    }

    // Same rule for the terms, and for the same reason: a rule that lives only on the input is not a rule.
    if (terms.gate.blockedReason !== undefined) {
      terms.refuse();
      toast.error(terms.gate.blockedReason);
      return;
    }

    setConsoleState({ phase: "submitting" });
    setActiveJobId(null);

    try {
      const target = buildTarget(values);

      // Upload the source archive first in upload-archive mode, so the manifest carries upload_id.
      let uploadedSource: SourceUploadResponse | undefined;
      if (includeManifest && sourceArchive.mode === "upload_archive") {
        uploadedSource = await sourceArchive.upload(values.source_sha256);
      }

      const manifest = includeManifest
        ? buildInlineManifest(values, uploadedSource, sourceArchive.mode)
        : undefined;
      const res = await submitMutation.mutateAsync({
        data: {
          target,
          manifest,
          // The version this browser was shown, never anything the user typed. Omitted while no bundle
          // loaded, which the terms gate has already refused above.
          ...(terms.gate.version ? { accepted_terms_version: terms.gate.version } : {}),
        } as unknown as SubmitRequestDto,
      });
      // No cast and no `normalizeStatus`.
      const data = res.data;
      setConsoleState({ phase: "accepted", response: data });

      if (data.status === "incomplete") {
        toast.warning("More information is needed");
        prefillEvidenceFields(data.available_fields ?? data.prefill);
        return;
      }

      toast.success("Verification job queued");
      // Before anything can navigate away: this response is the ONLY time the token is emitted, and losing it
      // means losing the raw build log for good (build-log-access design.md BL-1).
      rememberBuildLogToken(data.job_id, data.build_log_token);
      rememberCurrentJob(data.job_id, "queued", { target: data.target });
      navigate({
        to: "/verify/jobs/$job_id",
        params: { job_id: data.job_id },
        replace: true,
      });
      setActiveJobId(data.job_id);
    } catch (error) {
      // A refused submission lands here rather than above — see `submitRejection`.
      const failure = submitRejection(error);
      failWith(failure);
      toast.error(failure.detail);
    }
  };

  /** Stage one: ask preflight whether this contract can be verified at all, and stop here if it cannot. */
  const submitTarget = async () => {
    const field = targetType === "contract_id" ? "contractId" : "wasmHash";
    const valid = await form.trigger(field);
    if (!valid) {
      const msg = form.formState.errors[field]?.message;
      toast.error(msg || "Please fix the form errors before submitting.");
      return;
    }
    sourceArchive.reset();
    setConsoleState({ phase: "idle" });
    setActiveJobId(null);

    const next = await preflight.run(targetType);
    if (next.phase !== "answered") return;

    if (next.verdict.gate === "blocked") {
      toast.warning("This contract cannot be submitted — see the reason above.");
      return;
    }

    // Everything the chain already stated, so the submitter supplies only what is genuinely missing.
    prefillEvidenceFields({
      ...(next.response.available_fields ?? {}),
      ...(next.response.suggested_manifest ?? {}),
    });
  };

  /** The prefilled recipe belongs to the answer above, so it is cleared with it and never merged across targets. */
  const clearEvidence = useCallback(() => {
    for (const field of evidenceFields) {
      form.setValue(field, defaultValues[field]);
      form.clearErrors(field);
    }
  }, [form]);

  // Preflight's answer is about the target it was asked about. Editing the target invalidates it, and a stale
  // "ready" would gate a submission of a contract nobody checked.
  const resetPreflight = preflight.reset;
  const resetSourceArchive = sourceArchive.reset;
  useEffect(() => {
    resetPreflight();
    // Everything below is evidence about the target being left. A field the next target's chain does not state
    // would otherwise stay on screen — and be submitted — as the previous contract's.
    clearEvidence();
    resetSourceArchive();
    // Same "adjusting state when an input changes" as the `forceNew` effect above: the list describes a
    // `bldopt` the line before this one just cleared.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRejectedOptions([]);
  }, [
    resetPreflight,
    clearEvidence,
    resetSourceArchive,
    values.contractId,
    values.wasmHash,
    values.network,
    // Switching the picker is a change of target too, and left the previous one's evidence on screen.
    values.targetType,
  ]);

  /** Stage two: the evidence the verifier asked for. */
  const submitCompletedManifest = async () => {
    const refusals: { field?: "source_sha256" | "source_uri"; message: string }[] = [];

    // First, so an unchecked box is what the toast says even when fields are missing too: it is the refusal
    // a submitter is least likely to have noticed, having read the sentence as a notice rather than a control.
    if (terms.gate.blockedReason !== undefined) {
      terms.refuse();
      refusals.push({ message: terms.gate.blockedReason });
    }

    const shaRefusal = sourceSha256Refusal(values.source_sha256);
    if (shaRefusal) refusals.push({ field: "source_sha256", message: shaRefusal });

    if (sourceArchive.mode === "public_uri") {
      const uriRefusal = sourceUriRefusal(values.source_uri);
      if (uriRefusal) refusals.push({ field: "source_uri", message: uriRefusal });
    } else {
      // Sets the picker's own inline refusal as a side effect — it has no form field to carry one.
      const archiveRefusal = sourceArchive.requireArchive();
      if (archiveRefusal) refusals.push({ message: archiveRefusal });
    }

    if (refusals.length > 0) {
      for (const { field, message } of refusals) {
        if (field) form.setError(field, { type: "required", message });
      }
      toast.error(refusals[0].message);
      return;
    }

    // Refusing here rather than letting the 400 come back is what keeps the endpoint out of a call whose answer
    // is already known.
    const sourceRefusal = chainSourceRefusal(chainSourceSha256, values.source_sha256);
    if (sourceRefusal) {
      // The server's own refusal sets the banner as well as the toast, so this one does too — otherwise
      // skipping the round trip would quietly cost the submitter the more durable half of the message.
      failWith({ code: sourceArchiveNotChainRecorded, detail: sourceRefusal });
      toast.error(sourceRefusal, { duration: 30_000 });
      return;
    }

    // UI1a: reject client-side what the verifier would reject, and label it `policy_rejected`.
    const options = validateBuildOptions(values.bldopt);
    setRejectedOptions(options.ok ? [] : options.rejected);
    if (!options.ok) {
      toast.error("Some build options cannot be replayed — see the reasons below.");
      return;
    }

    await submitToApi(true);
  };

  const selectTargetType = (nextType: TargetType) => {
    setTargetType(nextType);
    form.setValue("targetType", nextType);
    setConsoleState({ phase: "idle" });
    setActiveJobId(null);
  };

  const currentJobId = banner.jobId || initialJobId;

  const copyJobLink = async () => {
    if (!currentJobId || typeof window === "undefined") return;
    await copyValue(
      `${window.location.origin}/verify/jobs/${encodeURIComponent(currentJobId)}`,
    );
  };

  const isTerminal =
    submissionState !== "idle" && submissionState !== "submitting";

  const resultView = useJobResultView({ consoleState, submissionState, currentJobId, recentJobs });

  // The `incomplete` arm is the only submit response carrying either, and only on the race path where the chain
  // changed between preflight and submit.
  const incomplete =
    consoleState.phase === "accepted" && consoleState.response.status === "incomplete"
      ? consoleState.response
      : undefined;

  return {
    form,
    values,
    recentJobs,

    submissionState,
    /** Everything the banner renders, already resolved — components do not read raw response fields. */
    banner,
    /** The result area: `jobTiming`, `buildLog`, `buildLogToken`, `jobResult`, `publishedArtifact`, `provenanceGroups`. */
    ...resultView,
    isSubmitting: submissionState === "submitting",
    /** A submission has settled — render the result area. */
    hasResult: isTerminal,
    showSubmitForm: mode === "submit" || submissionState === "incomplete",
    // Evidence is offered once preflight has cleared the contract.
    showEvidenceForm:
      submissionState === "incomplete" ||
      (preflight.state.phase === "answered" &&
        preflight.state.verdict.gate === "ready" &&
        submissionState === "idle"),
    responseMeta: isTerminal ? responseCopy[submissionState] : null,
    currentStep: flowStepIndex(submissionState),
    isFailed: isFailedState(submissionState),

    currentJobId,
    copyJobLink,

    targetType,
    selectTargetType,
    submitTarget,

    preflight: preflight.state,
    /** Stage two is offered only once preflight said this contract can be verified. */
    isPreflightReady:
      preflight.state.phase === "answered" && preflight.state.verdict.gate === "ready",

    // Preflight is the source once it has answered; a submit `incomplete` still supplies it on the race path,
    // which is why the submit response is read first when one exists.
    availableFields:
      incomplete?.available_fields ||
      incomplete?.prefill ||
      (preflight.state.phase === "answered" ? preflight.state.response.available_fields : {}) ||
      {},
    sourceArchive,
    submitCompletedManifest,
    rejectedOptions,
    terms: terms.props,
  };
};

export type VerificationConsole = ReturnType<typeof useVerificationConsole>;
