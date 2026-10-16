import type { ApiErrorResponse } from "@scvs/verify-api-client";
import { errorMessage, isHttpError } from "@/lib/http";
import type {
  BannerView,
  ConsoleFailure,
  ConsoleState,
  RecentJob,
  ResultTone,
  SubmissionState,
  VerificationTarget,
} from "../types";

export const submitErrorText = (body: ApiErrorResponse) =>
  body.message || body.detail || body.error || "";

export const submitRejection = (error: unknown): ConsoleFailure => {
  const body = isHttpError(error) ? (error.response?.data as ApiErrorResponse | undefined) : undefined;
  const detail = body ? submitErrorText(body) : "";
  if (body?.error && detail) return { code: body.error, detail };
  return {
    code: "network_error",
    detail: errorMessage(error, "Unable to reach verification API."),
  };
};

export const consoleStateToSubmissionState = (state: ConsoleState): SubmissionState => {
  switch (state.phase) {
    case "idle":
      return "idle";
    case "submitting":
      return "submitting";
    case "accepted":
      return state.response.status;
    case "job":
      return state.state;
    case "failed":
      return "error";
  }
};

export const bannerView = (state: ConsoleState): BannerView => {
  switch (state.phase) {
    case "idle":
    case "submitting":
      return {};
    case "accepted":
      return {
        detail: state.response.message,
        jobId: state.response.status === "queued" ? state.response.job_id : undefined,
        target: state.response.target,
      };
    case "job":
      return {
        detail: state.response.detail,
        code: state.response.reason,
        jobId: state.response.job_id,
        target: state.response.target,
      };
    case "failed":
      return {
        detail: state.failure.detail,
        code: state.failure.code,
        jobId: state.failure.job_id,
      };
  }
};

export const getTargetSummary = (target?: VerificationTarget) => {
  if (!target) {
    return { kind: "Target", value: "Unknown target", title: "Unknown target" };
  }
  if (target.contract_id) {
    return {
      kind: "Contract ID",
      value: target.contract_id,
      title: target.contract_id,
    };
  }
  if (target.wasm_hash) {
    return {
      kind: "Wasm hash",
      value: target.wasm_hash,
      title: target.wasm_hash,
    };
  }
  return {
    kind: "Network",
    value: target.network || "Unknown target",
    title: target.network || "Unknown target",
  };
};

export const getRecentJobTone = (status: RecentJob["status"]): ResultTone => {
  if (status === "verified") return "success";
  if (
    status === "mismatch" ||
    status === "source_unavailable" ||
    status === "build_failed" ||
    status === "policy_rejected" ||
    status === "error"
  ) {
    return "danger";
  }
  return "warning";
};

export const resultSummaryEntries = (result?: Record<string, unknown>) => {
  if (!result) return [];
  const keys = ["rebuilt_wasm_hash", "matched", "arweave_tx_id"];
  return keys
    .filter((key) => {
      const value = result[key];
      if (key === "rebuilt_wasm_hash" && result.matched !== false) return false;
      if (
        key === "matched" &&
        value === true &&
        result.status_summary === "verified"
      ) {
        return false;
      }
      if (key === "matched" && value === false && !result.rebuilt_wasm_hash) {
        return false;
      }
      return value !== undefined && value !== "";
    })
    .map((key) => [key, result[key]] as const);
};

export const resultLabel = (key: string) => {
  const labels: Record<string, string> = {
    status_summary: "Status",
    wasm_hash: "Target Wasm hash",
    rebuilt_wasm_hash: "Rebuilt Wasm hash",
    matched: "Matched",
    verified_at: "Verified at",
    build_image: "Build image",
    source_type: "Source type",
    source_visibility: "Source visibility",
    source_uri: "Source URI",
    source_sha256: "Source SHA-256",
    image_trust: "Image trust",
    source_retrieval: "Source retrieval",
    verification_path: "Verification path",
    evidence_source: "Evidence source",
    artifact_url: "Artifact URL",
    artifact_sha256: "Artifact SHA-256",
    arweave_tx_id: "Arweave tx id",
  };
  return labels[key] || key;
};

const COMPOSITION_FAILURE_REASONS = new Set([
  "smoke_test_failed",
  "image_build_failed",
  "cli_archive_extract_failed",
  "component_unreachable",
  "component_too_large",
  "ecr_push_failed",
  "ecr_auth_failed",
  "composition_template_invalid",
  "composer_params_invalid",
  "composer_internal_error",
  "receipt_upload_failed",
]);

export const troubleshootingMessage = (
  state: SubmissionState,
  result?: Record<string, unknown>,
) => {
  const reason = typeof result?.reason === "string" ? result.reason : "";
  if (reason === "sandbox_unavailable") {
    return "The verifier could not start its build sandbox, so your source was never rebuilt. Nothing in your submission needs changing — this is a problem on the verifier's side. Resubmit later, or tell the verifier's operator if it keeps happening.";
  }
  // Before the state checks: these report `build_failed`, whose own advice is wrong here.
  if (COMPOSITION_FAILURE_REASONS.has(reason)) {
    return "The verifier could not build the environment this contract's on-chain metadata records, so your source was never rebuilt. Nothing in your submission needs changing — this is a problem on the verifier's side. Resubmit once the verifier reports it fixed.";
  }
  if (state === "mismatch") {
    return "The source rebuilt successfully, but the rebuilt Wasm hash does not match the deployed Wasm. Check the source revision, build image, feature flags, profile, toolchain, and dependency lockfile.";
  }
  if (state === "build_failed") {
    return "The rebuild failed inside the selected verification environment. Check the manifest path, package name, build options, source archive layout, and whether the chosen build image can build this project.";
  }
  if (state === "source_unavailable") {
    return "The verifier could not read the source archive. Check that the URI is reachable or upload the archive directly.";
  }
  if (state === "policy_rejected") {
    return "The build image did not pass verifier policy. Use a fully qualified, digest-pinned trusted image.";
  }
  return "";
};
