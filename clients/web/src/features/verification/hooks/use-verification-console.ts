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
  const [consoleState, setConsoleState] = useState<ConsoleState>({ phase: "idle" });
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [rejectedOptions, setRejectedOptions] = useState<RejectedBuildOption[]>([]);
  const terms = useTermsGate();

  const recentJobs = useRecentJobs();
  const preflight = usePreflight(form);
  const chainSourceField =
    preflight.state.phase === "answered"
      ? preflight.state.response.available_fields?.source_sha256
      : undefined;
  const chainSourceSha256 =
    typeof chainSourceField === "string" ? chainSourceField : undefined;
  const sourceArchive = useSourceArchive(form, chainSourceSha256);
  const submitMutation = useSubmitVerification();

  const watched = useWatch({ control: form.control });
  const values: VerifyFormValues = { ...defaultValues, ...watched };

  const banner = bannerView(consoleState);
  const submissionState = consoleStateToSubmissionState(consoleState);

  const rememberCurrentJob = (
    jobId: string,
    status: RecentJob["status"],
    nextResponse?: Partial<JobResponse>,
    /** Only the verifier's own `updated_at` is stored as `finished_at`, never this tab's clock. */
    options: { settled?: boolean } = {},
  ) => {
    const now = new Date().toISOString();
    rememberJob({
      job_id: jobId,
      status,
      target: nextResponse?.target || banner.target,
      detail: nextResponse?.detail || banner.detail,
      created_at: nextResponse?.created_at || now,
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
      // The stream sends partial updates, so progress merges into the previous response.
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

  const restoreJob = (jobId: string) => {
    if (!isApiBaseConfigured()) {
      setConsoleState({
        phase: "failed",
        failure: { code: "missing_api_url", detail: MISSING_API_URL_DETAIL, job_id: jobId },
      });
      return;
    }

    setConsoleState({ phase: "submitting" });
    setActiveJobId(jobId);
  };

  useEffect(() => {
    if (forceNew) {
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

    if (terms.gate.blockedReason !== undefined) {
      terms.refuse();
      toast.error(terms.gate.blockedReason);
      return;
    }

    setConsoleState({ phase: "submitting" });
    setActiveJobId(null);

    try {
      const target = buildTarget(values);

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
          // Only the version this browser was shown, never anything the user typed.
          ...(terms.gate.version ? { accepted_terms_version: terms.gate.version } : {}),
        } as unknown as SubmitRequestDto,
      });
      const data = res.data;
      setConsoleState({ phase: "accepted", response: data });

      if (data.status === "incomplete") {
        toast.warning("More information is needed");
        prefillEvidenceFields(data.available_fields ?? data.prefill);
        return;
      }

      toast.success("Verification job queued");
      // Before anything can navigate away: this response is the only time the token is emitted.
      rememberBuildLogToken(data.job_id, data.build_log_token);
      rememberCurrentJob(data.job_id, "queued", { target: data.target });
      navigate({
        to: "/verify/jobs/$job_id",
        params: { job_id: data.job_id },
        replace: true,
      });
      setActiveJobId(data.job_id);
    } catch (error) {
      const failure = submitRejection(error);
      failWith(failure);
      toast.error(failure.detail);
    }
  };

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

    prefillEvidenceFields({
      ...(next.response.available_fields ?? {}),
      ...(next.response.suggested_manifest ?? {}),
    });
  };

  const clearEvidence = useCallback(() => {
    for (const field of evidenceFields) {
      form.setValue(field, defaultValues[field]);
      form.clearErrors(field);
    }
  }, [form]);

  // Editing the target invalidates preflight and its evidence; a stale "ready" must not gate a submission.
  const resetPreflight = preflight.reset;
  const resetSourceArchive = sourceArchive.reset;
  useEffect(() => {
    resetPreflight();
    clearEvidence();
    resetSourceArchive();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRejectedOptions([]);
  }, [
    resetPreflight,
    clearEvidence,
    resetSourceArchive,
    values.contractId,
    values.wasmHash,
    values.network,
    values.targetType,
  ]);

  const submitCompletedManifest = async () => {
    const refusals: { field?: "source_sha256" | "source_uri"; message: string }[] = [];

    // First, so the toast names the terms refusal even when fields are missing too.
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

    const sourceRefusal = chainSourceRefusal(chainSourceSha256, values.source_sha256);
    if (sourceRefusal) {
      failWith({ code: sourceArchiveNotChainRecorded, detail: sourceRefusal });
      toast.error(sourceRefusal, { duration: 30_000 });
      return;
    }

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

  const incomplete =
    consoleState.phase === "accepted" && consoleState.response.status === "incomplete"
      ? consoleState.response
      : undefined;

  return {
    form,
    values,
    recentJobs,

    submissionState,
    banner,
    ...resultView,
    isSubmitting: submissionState === "submitting",
    hasResult: isTerminal,
    showSubmitForm: mode === "submit" || submissionState === "incomplete",
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
    isPreflightReady:
      preflight.state.phase === "answered" && preflight.state.verdict.gate === "ready",

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
