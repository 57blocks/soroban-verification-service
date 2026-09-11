/** Operations evidence for SUB cases whose setup intentionally cannot be exposed over an app API. */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

export interface Sub09InternalErrorEvidence {
  readonly jobId: string;
  readonly faultKind:
    | "batch_dispatch_unavailable"
    | "batch_job_failed_no_artifact"
    | "sandbox_unavailable"
    | "toolchain_probe_failed";
  readonly expectedErrorCode: string;
  readonly appliedAtMs: number;
  readonly restoredAtMs: number;
  readonly publishedBeforeSha256: string | null;
  readonly publishedAfterSha256: string | null;
}

export interface Sub11Evidence {
  readonly jobId: string;
  readonly imageDigest: string;
  readonly expectedErrorCode: string;
  readonly queuedAtMs: number;
  readonly policyChangedAtMs: number;
  readonly dispatchResumedAtMs: number;
  readonly restoredAtMs: number;
  readonly policyBeforeSha256: string;
  readonly policyRestrictedSha256: string;
}

export interface Dedup06InternalErrorEvidence {
  readonly jobId: string;
  readonly faultKind: Sub09InternalErrorEvidence["faultKind"];
  readonly expectedErrorCode: string;
  readonly expectedTerminalStatus: "verified" | "mismatch";
  readonly appliedAtMs: number;
  readonly failedAtMs: number;
  readonly restoredAtMs: number;
}

export interface Sub12Evidence {
  readonly jobId: string;
  readonly contractId: string;
  readonly oldHash: string;
  readonly newHash: string;
  readonly queuedAtMs: number;
  readonly upgradedAtMs: number;
  readonly dispatchResumedAtMs: number;
  readonly restoredAtMs: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEvidence(variable: string): JsonRecord {
  const configured = process.env[variable]?.trim();
  if (!configured) throw new Error(`${variable} is not set.`);
  const path = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  if (!existsSync(path)) throw new Error(`${variable} points to a file that does not exist.`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("root must be an object");
    return parsed;
  } catch (error) {
    throw new Error(
      `${variable} is not valid evidence JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function literal<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`Evidence field ${field} has the wrong literal value.`);
  return expected;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Evidence field ${field} must be a non-empty string.`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  const parsed = Date.parse(string(value, field));
  if (!Number.isFinite(parsed)) throw new Error(`Evidence field ${field} must be an ISO-8601 timestamp.`);
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = string(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`Evidence field ${field} must be a SHA-256 hex digest.`);
  }
  return parsed;
}

function nullableSha256(value: unknown, field: string): string | null {
  return value === null ? null : sha256(value, field);
}

function contractId(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!/^C[A-Z2-7]{55}$/.test(parsed)) {
    throw new Error(`Evidence field ${field} must be a Stellar contract id.`);
  }
  return parsed;
}

function ordered(label: string, values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < values[index - 1]) {
      throw new Error(`Evidence timestamps for ${label} are not in the required order.`);
    }
  }
}

export function readSub09InternalErrorEvidence(): Sub09InternalErrorEvidence {
  const root = readEvidence("SCVS_E2E_SUB09_INTERNAL_ERROR_EVIDENCE_PATH");
  literal(root.schema, "scvs-e2e-sub09-internal-error-v1", "schema");
  const faultKind = string(root.fault_kind, "fault_kind");
  const allowed = [
    "batch_dispatch_unavailable",
    "batch_job_failed_no_artifact",
    "sandbox_unavailable",
    "toolchain_probe_failed",
  ] as const;
  if (!allowed.includes(faultKind as (typeof allowed)[number])) {
    throw new Error("Evidence field fault_kind is not an approved infrastructure fault.");
  }
  const appliedAtMs = timestamp(root.applied_at, "applied_at");
  const restoredAtMs = timestamp(root.restored_at, "restored_at");
  ordered("SUB-09/internal_error", [appliedAtMs, restoredAtMs]);
  return {
    jobId: string(root.job_id, "job_id"),
    faultKind: faultKind as Sub09InternalErrorEvidence["faultKind"],
    expectedErrorCode: string(root.expected_error_code, "expected_error_code"),
    appliedAtMs,
    restoredAtMs,
    publishedBeforeSha256: nullableSha256(root.published_before_sha256, "published_before_sha256"),
    publishedAfterSha256: nullableSha256(root.published_after_sha256, "published_after_sha256"),
  };
}

/**
 * The operation creates a valid job while the fault is active, waits until its first `internal_error` failure,
 * restores the fault, then immediately starts this case so the public failed -> queued transition remains
 * observable.
 */
export function readDedup06InternalErrorEvidence(): Dedup06InternalErrorEvidence {
  const root = readEvidence("SCVS_E2E_DEDUP06_INTERNAL_ERROR_EVIDENCE_PATH");
  literal(root.schema, "scvs-e2e-dedup06-internal-error-v1", "schema");
  const faultKind = string(root.fault_kind, "fault_kind");
  const allowed = [
    "batch_dispatch_unavailable",
    "batch_job_failed_no_artifact",
    "sandbox_unavailable",
    "toolchain_probe_failed",
  ] as const;
  if (!allowed.includes(faultKind as (typeof allowed)[number])) {
    throw new Error("Evidence field fault_kind is not an approved infrastructure fault.");
  }
  const appliedAtMs = timestamp(root.applied_at, "applied_at");
  const failedAtMs = timestamp(root.failed_at, "failed_at");
  const restoredAtMs = timestamp(root.restored_at, "restored_at");
  ordered("DEDUP-06/internal_error_requeued", [appliedAtMs, failedAtMs, restoredAtMs]);
  const expectedTerminalStatus = string(root.expected_terminal_status, "expected_terminal_status");
  if (expectedTerminalStatus !== "verified" && expectedTerminalStatus !== "mismatch") {
    throw new Error("Evidence field expected_terminal_status must be verified or mismatch.");
  }
  return {
    jobId: string(root.job_id, "job_id"),
    faultKind: faultKind as Dedup06InternalErrorEvidence["faultKind"],
    expectedErrorCode: string(root.expected_error_code, "expected_error_code"),
    expectedTerminalStatus,
    appliedAtMs,
    failedAtMs,
    restoredAtMs,
  };
}

export function readSub11Evidence(): Sub11Evidence {
  const root = readEvidence("SCVS_E2E_SUB11_EVIDENCE_PATH");
  literal(root.schema, "scvs-e2e-sub11-v1", "schema");
  const imageDigest = string(root.image_digest, "image_digest");
  if (!/@sha256:[a-f0-9]{64}$/i.test(imageDigest)) {
    throw new Error("Evidence field image_digest must be a digest-pinned image reference.");
  }
  const queuedAtMs = timestamp(root.queued_at, "queued_at");
  const policyChangedAtMs = timestamp(root.policy_changed_at, "policy_changed_at");
  const dispatchResumedAtMs = timestamp(root.dispatch_resumed_at, "dispatch_resumed_at");
  const restoredAtMs = timestamp(root.restored_at, "restored_at");
  ordered("SUB-11", [queuedAtMs, policyChangedAtMs, dispatchResumedAtMs, restoredAtMs]);
  return {
    jobId: string(root.job_id, "job_id"),
    imageDigest,
    expectedErrorCode: string(root.expected_error_code, "expected_error_code"),
    queuedAtMs,
    policyChangedAtMs,
    dispatchResumedAtMs,
    restoredAtMs,
    policyBeforeSha256: sha256(root.policy_before_sha256, "policy_before_sha256"),
    policyRestrictedSha256: sha256(root.policy_restricted_sha256, "policy_restricted_sha256"),
  };
}

export function readSub12Evidence(): Sub12Evidence {
  const root = readEvidence("SCVS_E2E_SUB12_EVIDENCE_PATH");
  literal(root.schema, "scvs-e2e-sub12-v1", "schema");
  const queuedAtMs = timestamp(root.queued_at, "queued_at");
  const upgradedAtMs = timestamp(root.upgraded_at, "upgraded_at");
  const dispatchResumedAtMs = timestamp(root.dispatch_resumed_at, "dispatch_resumed_at");
  const restoredAtMs = timestamp(root.restored_at, "restored_at");
  ordered("SUB-12", [queuedAtMs, upgradedAtMs, dispatchResumedAtMs, restoredAtMs]);
  const oldHash = sha256(root.old_hash, "old_hash");
  const newHash = sha256(root.new_hash, "new_hash");
  if (oldHash === newHash) throw new Error("SUB-12 evidence old_hash and new_hash must differ.");
  return {
    jobId: string(root.job_id, "job_id"),
    contractId: contractId(root.contract_id, "contract_id"),
    oldHash,
    newHash,
    queuedAtMs,
    upgradedAtMs,
    dispatchResumedAtMs,
    restoredAtMs,
  };
}
