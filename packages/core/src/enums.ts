import { createEnumAssert, createEnumGuard } from "./validate.js";

export const networks = ["mainnet", "testnet"] as const;
export type Network = (typeof networks)[number];
export const isNetwork = createEnumGuard(networks);
export const assertNetwork = createEnumAssert(networks, "network");

export const verificationStatuses = [
  "verified",
  "mismatch",
  "build_failed",
  "source_unavailable",
  "policy_rejected",
  "not_attempted",
  "queued",
  "running",
] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];
export const isVerificationStatus = createEnumGuard(verificationStatuses);
export const assertVerificationStatus = createEnumAssert(verificationStatuses, "status");

export const submissionStatuses = ["queued", "incomplete"] as const;
export type SubmissionStatus = (typeof submissionStatuses)[number];
export const isSubmissionStatus = createEnumGuard(submissionStatuses);

// `published`, `evaluated` and `failed` are terminal; `publish_pending` is not: its verdict is fixed and only publication retries.
export const jobStatuses = [
  "queued",
  "preparing",
  "building",
  "comparing",
  "publishing",
  "publish_pending",
  "published",
  "evaluated",
  "failed",
] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const isJobStatus = createEnumGuard(jobStatuses);
export const assertJobStatus = createEnumAssert(jobStatuses, "status");

export const terminalJobStatuses = [
  "published",
  "evaluated",
  "failed",
] as const satisfies readonly JobStatus[];
export type TerminalJobStatus = (typeof terminalJobStatuses)[number];
export const isTerminalJobStatus = createEnumGuard(terminalJobStatuses);

// A mismatch is a successful verification, so it is a verdict, not a failure reason.
export const failureReasons = [
  "policy_rejected",
  "unsupported",
  "missing_fields",
  "source_unreachable",
  "build_failed",
  "build_timeout",
  "internal_error",
] as const;
export type FailureReason = (typeof failureReasons)[number];
export const isFailureReason = createEnumGuard(failureReasons);
export const assertFailureReason = createEnumAssert(failureReasons, "failureReason");

// Only failures where re-running identical input can produce a different answer.
export const retryableFailureReasons: readonly FailureReason[] = [
  "build_timeout",
  "internal_error",
];

const retryableFailureReasonSet: ReadonlySet<FailureReason> = new Set(retryableFailureReasons);

export function isRetryableFailure(reason: FailureReason): boolean {
  return retryableFailureReasonSet.has(reason);
}

/** Shared by the retry scan and `hasOutstandingObligation`; the two windows must stay equal. */
export const RETRY_ELIGIBILITY_WINDOW_MS = 60 * 60_000;

export const DEFAULT_MAX_JOB_RETRY_ATTEMPTS = 3;

export const verdicts = ["verified", "mismatched"] as const;
export type Verdict = (typeof verdicts)[number];
export const isVerdict = createEnumGuard(verdicts);
export const assertVerdict = createEnumAssert(verdicts, "verdict");

export function toWireVerificationStatus(
  status: JobStatus,
  failureReason?: FailureReason | null,
  verdict?: Verdict | null,
): VerificationStatus {
  switch (status) {
    case "queued":
    case "preparing":
      return "queued";
    case "building":
    case "comparing":
    case "publishing":
    case "publish_pending":
      return "running";
    case "published":
    case "evaluated":
      return verdict === "mismatched" ? "mismatch" : "verified";
    case "failed":
      switch (failureReason) {
        case "policy_rejected":
          return "policy_rejected";
        case "unsupported":
          return "not_attempted";
        case "source_unreachable":
        case "missing_fields":
          return "source_unavailable";
        case "build_failed":
        case "build_timeout":
        case "internal_error":
        default:
          return "build_failed";
      }
  }
}

export const buildModes = ["verify", "build"] as const;
export type BuildMode = (typeof buildModes)[number];
export const isBuildMode = createEnumGuard(buildModes);
export const assertBuildMode = createEnumAssert(buildModes, "buildMode");

export const mechanismReasons = [
  "on_chain_recipe_in_trusted_image",
  "image_not_policy_accepted",
  "no_chain_recorded_image",
  "environment_is_composed",
  "recipe_deviates_from_chain",
] as const;
export type MechanismReason = (typeof mechanismReasons)[number];
export const isMechanismReason = createEnumGuard(mechanismReasons);
export const assertMechanismReason = createEnumAssert(mechanismReasons, "mechanismReason");

export const verificationModes = ["metadata", "submitted"] as const;
export type VerificationMode = (typeof verificationModes)[number];
export const isVerificationMode = createEnumGuard(verificationModes);
export const assertVerificationMode = createEnumAssert(verificationModes, "verificationMode");
