/** Read `setup/global-teardown.cjs` first for why this exists at all. */
import { appendFileSync } from "node:fs";

import { env } from "./env.js";

export interface Gap {
  readonly id: string;
  readonly required: string;
  /** What the deployment does instead, and where that is already written down. */
  readonly observed: string;
  /** The document that records it, so a reader can check whether it has since been closed. */
  readonly recordedIn: string;
}

/** Every entry below was found by reading the implementation against the case files. */
export const GAPS = {
  ERROR_ENVELOPE_SCHEMA_VERSION: {
    id: "RC2/RC6-schema_version",
    required:
      "Non-Registry routes return `{schema_version, error, message}` (RC6); cases assert the `error` value against that envelope.",
    observed:
      "`services/query-svc` emits `{error, message, status_code}` from its own `common/api-error.exception.ts` and its catch-all filter, with no `schema_version` on any route. `verification-svc` does stamp it.",
    recordedIn: "the recipe-contract rules RC2 and RC6, the latter only partially held",
  },

  JOB_STATUS_VOCABULARY: {
    id: "SO1-mismatch-vs-mismatched",
    required:
      "The verdict vocabulary is `verified | mismatched | unverified`; the required spelling is `mismatched`, not `mismatch`.",
    observed:
      "The published status object does use `mismatched`. The *job* surface does not: `VerificationStatus` in `packages/core/src/enums.ts` is `verified | mismatch | …`, so `GET /api/verification/v1/verifications/:id` reports `mismatch`. Two vocabularies, one word apart.",
    recordedIn: "the verdict vocabulary the status object publishes (SO1)",
  },

  // ── Removed 2026-08-20: `ROUTE_SOURCE`, `VERIFIED_SOURCE_CODE_URI`, `STATUS_OBJECT_SOURCE_FIELDS` ──
  // These three recorded that `GET /v1/source/{source_sha256}`, `verified_source_code_uri`, and the SEP-58
  // v0.5.0 pair `source_sha256`/`source_uri` are unimplemented.

  // ── Retired 2026-08-20: `MALICIOUS_ARCHIVE_REASON` (`SEC-03-reason`) ──────────────────────────────
  // So `E2E-SEC-03` now asserts the wire status `source_unavailable` outright.

  SYNC_REJECTION_HAS_NO_LOG: {
    id: "GAP-4-no-job-no-log",
    required:
      "§4.5 says all seven failures return a build log; §7.6 says three synchronous 4xx failures create no job row.",
    observed:
      "With no job there is nowhere to attach a log. The cases provisionally expect no build log.",
    recordedIn: "a specification gap: nothing defines this, and the suite pins current behaviour",
  },

  NO_REBUILD_IDENTITY: {
    id: "GAP-3-no-cache-hit-signal",
    required:
      "§7.6 Rule A: identical input must not cause a second build, and that must be observable.",
    observed:
      "No published surface carries a rebuild ID or cache-hit indicator, so Rule A cannot be asserted directly. `dedup.ts` implements the case files' three-condition substitute instead.",
    recordedIn: "a specification gap in deduplication: nothing defines this, and the suite pins current behaviour",
  },

  /** `services/verification-svc/src/modules/preflight/manifest.ts` — `firstBldoptShapeViolation`. */
  BLDOPT_NON_EQUALS_ERROR: {
    id: "SUB-13-bldopt-error-code",
    required:
      "`E2E-SUB-13/non_equals_form`: a non-`=` `bldopt` entry is either rejected with `error == \"policy_rejected\"` or normalised to the `=` form — never silently dropped (S12).",
    observed:
      "It is rejected — correct on the substance, S12 holds — but the code is `invalid_manifest`, not `policy_rejected`. The rejection is deliberate and documented: normalising would have the service rewrite a recipe that is hashed into the idempotency key and published as evidence.",
    recordedIn:
      "services/verification-svc/src/modules/preflight/manifest.ts — `firstBldoptShapeViolation` doc comment (2026-08-13)",
  },

  /** `E2E-PUB-07/log_pointer`. */
  REPORT_LOG_POINTER: {
    id: "PUB-07-build_log_url",
    required: "`E2E-PUB-07/log_pointer`: `diagnostics.build_log_url` exists in the report and resolves.",
    observed:
      "No `build_log_url` field exists anywhere in `packages/`, `services/` or `clients/`. `VerificationResultSummary.sandbox_diagnostics` carries excerpts and an exit code; the log is reachable through the job surface instead.",
    recordedIn:
      "the publishing cases: sibling assertions were corrected for exactly this class of error",
  },
} as const satisfies Record<string, Gap>;

export type GapKey = keyof typeof GAPS;

/**
 * Default mode records the divergence and continues, so the rest of the case still runs and the run still ends
 * green when nothing *unknown* broke.
 */
export function expectPerTrd(gapKey: GapKey, caseId: string, assertion: () => void): void {
  try {
    assertion();
  } catch (error) {
    const gap = GAPS[gapKey];
    const detail = error instanceof Error ? firstLine(error.message) : String(error);

    if (env.strictTrd) throw error;

    record({ gap: gap.id, case: caseId, detail, required: gap.required, observed: gap.observed });
  }
}

function record(entry: Record<string, string>): void {
  const line = `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`;
  const logPath = process.env.SCVS_E2E_DRIFT_LOG;
  if (!logPath) {
    process.stdout.write(`[drift] ${line}`);
    return;
  }
  try {
    appendFileSync(logPath, line);
  } catch {
    process.stdout.write(`[drift] ${line}`);
  }
}

function firstLine(message: string): string {
  return message.split("\n").find((l) => l.trim().length > 0)?.trim() ?? message;
}
