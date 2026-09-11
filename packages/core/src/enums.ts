import { createEnumAssert, createEnumGuard } from "./validate.js";

export const networks = ["mainnet", "testnet"] as const;
export type Network = (typeof networks)[number];
export const isNetwork = createEnumGuard(networks);
export const assertNetwork = createEnumAssert(networks, "network");

// External HTTP contract only (job polling / result responses).
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

// IMPLEMENTATION-SPEC **RC7**'s closed set: what `POST /v1/verifications` answers with, never a `JobStatus`.
export const submissionStatuses = ["queued", "incomplete"] as const;
export type SubmissionStatus = (typeof submissionStatuses)[number];
export const isSubmissionStatus = createEnumGuard(submissionStatuses);

// `published`, `evaluated` and `failed` are terminal. `publish_pending` is NOT: the verdict already exists and
// is never recomputed there — only publication retries.
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

// The terminal members of the set above. Shared because `verification-pipeline.service.ts`,
// `upload-job-references.repo.ts` and `JobsRepository.advanceJob` must agree on them.
export const terminalJobStatuses = [
  "published",
  "evaluated",
  "failed",
] as const satisfies readonly JobStatus[];
export type TerminalJobStatus = (typeof terminalJobStatuses)[number];
export const isTerminalJobStatus = createEnumGuard(terminalJobStatuses);

// `mismatched` is deliberately NOT among them: a mismatch is a *successful verification* — the comparison ran
// and answered — and lives on `verdicts` below.
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

// Exactly two: a wall-clock limit and an infrastructure fault are the only reasons re-running the identical
// input can produce a different answer.
export const retryableFailureReasons: readonly FailureReason[] = [
  "build_timeout",
  "internal_error",
];

const retryableFailureReasonSet: ReadonlySet<FailureReason> = new Set(retryableFailureReasons);

export function isRetryableFailure(reason: FailureReason): boolean {
  return retryableFailureReasonSet.has(reason);
}

/**
 * Shared between `requeueRetryableFailures`' scan and `hasOutstandingObligation`'s third arm so the two windows
 * cannot drift: a job the scan would still re-queue is exactly a job whose staged upload must survive, and vice
 * versa.
 */
export const RETRY_ELIGIBILITY_WINDOW_MS = 60 * 60_000;

/**
 * Shared so `hasOutstandingObligation`'s callers that have no reason to configure retries themselves
 * (`UploadCleanupService` in verification-svc) still compare against the same number the orchestrator defaults
 * to, rather than a second literal.
 */
export const DEFAULT_MAX_JOB_RETRY_ATTEMPTS = 3;

// Both are carried by `published` and by `evaluated`, and neither is a failure.
export const verdicts = ["verified", "mismatched"] as const;
export type Verdict = (typeof verdicts)[number];
export const isVerdict = createEnumGuard(verdicts);
export const assertVerdict = createEnumAssert(verdicts, "verdict");

/** Translates the internal state machine to the `VerificationStatus` values the HTTP contract speaks. */
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
    // A publication that is still being retried is work in progress, and the submitter is told so.
    case "publishing":
    case "publish_pending":
      return "running";
    case "published":
    // It carries `verified` or `mismatched` exactly like `published`.
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

// The value stays because persisted `Rebuild.buildMode` rows and published `verification_path: "cli"` carry it.
export const buildModes = ["verify", "build"] as const;
export type BuildMode = (typeof buildModes)[number];
export const isBuildMode = createEnumGuard(buildModes);
export const assertBuildMode = createEnumAssert(buildModes, "buildMode");

// Only the first two values are backed by an on-chain recipe; the other three are not, regardless of whether
// the job's HTTP request happened to carry a manifest.
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

// "metadata": resolved from on-chain contract metadata alone. "submitted": the caller provided a
// SubmittedSourceManifest. Set once at job creation (submit.service.ts).
export const verificationModes = ["metadata", "submitted"] as const;
export type VerificationMode = (typeof verificationModes)[number];
export const isVerificationMode = createEnumGuard(verificationModes);
export const assertVerificationMode = createEnumAssert(verificationModes, "verificationMode");
