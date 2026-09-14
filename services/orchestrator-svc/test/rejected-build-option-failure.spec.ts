import { isRetryableFailure } from "@scvs/core";
import {
  rebuildFailureDetail,
  rebuildFailureReason,
} from "../src/modules/verification-pipeline/failure-reason.util.js";
import type { RebuildRecord } from "@scvs/db";

/**
 * The failure was `build_failed` + *"The sandbox rebuild could not be completed for this source and image."*
 * That is wrong twice: the submitted source builds fine, and nothing said which of the recorded options the
 * image refused.
 */
const rebuild = (
  errorCode: string,
  diagnostics: Record<string, unknown> = {},
): RebuildRecord =>
  ({ rebuildId: "11111111-2222-3333-4444-555555555555", errorCode, diagnostics }) as unknown as RebuildRecord;

const GENERIC = "The sandbox rebuild could not be completed for this source and image.";

describe("a recorded build option the image rejects", () => {
  const record = rebuild("recorded_build_option_unsupported", {
    rejected_build_option: "--locked",
    rejected_build_option_origin: "recorded_bldopt",
  });

  it("is policy_rejected, not build_failed", () => {
    // The recipe is inadmissible in this environment; the source is not the problem.
    expect(rebuildFailureReason(record)).toBe("policy_rejected");
  });

  it("stays non-retryable, so this moves only what the submitter is told", () => {
    expect(isRetryableFailure("policy_rejected")).toBe(false);
    expect(isRetryableFailure("build_failed")).toBe(false);
  });

  it("names the flag and says the source is not at fault", () => {
    const detail = rebuildFailureDetail(record);

    expect(detail).toContain("--locked");
    expect(detail).toContain("recorded build option");
    expect(detail).toContain("source is not the problem");
    expect(detail).not.toBe(GENERIC);
  });
});

describe("a build option the verifier added and the image rejects", () => {
  const record = rebuild("added_build_option_unsupported", {
    rejected_build_option: "--out-dir",
    rejected_build_option_origin: "verifier_added",
  });

  it("is internal_error — our probe gap, not the recipe's fault", () => {
    expect(rebuildFailureReason(record)).toBe("internal_error");
  });

  it("is retryable, because a deploy can fix it where a resubmission cannot", () => {
    expect(isRetryableFailure("internal_error")).toBe(true);
  });

  it("tells the submitter it is ours and needs nothing from them", () => {
    const detail = rebuildFailureDetail(record);

    expect(detail).toContain("--out-dir");
    expect(detail).toContain("verifier fault");
    // The one thing this arm must not do is send the submitter to inspect their own recipe.
    expect(detail).not.toContain("source is not the problem");
  });
});

describe("an artifact no report stated a hash for", () => {
  const record = rebuild("artifact_report_hash_missing");

  it("is build_failed, and deliberately not internal_error", () => {
    // The same code also covers a compile that printed a report of its own — the source's doing, not ours.
    expect(rebuildFailureReason(record)).toBe("build_failed");
  });

  it("stays non-retryable, so a refused artifact is not handed another attempt", () => {
    expect(isRetryableFailure(rebuildFailureReason(record))).toBe(false);
  });
});

describe("everything else is unchanged", () => {
  it("keeps the generic detail when no option was identified", () => {
    expect(rebuildFailureDetail(rebuild("rebuild_command_failed"))).toBe(GENERIC);
    expect(rebuildFailureReason(rebuild("rebuild_command_failed"))).toBe("build_failed");
  });

  it("keeps the generic detail when an origin arrives with no flag", () => {
    // Half-populated diagnostics must not produce a sentence with a hole in it.
    expect(
      rebuildFailureDetail(rebuild("rebuild_command_failed", { rejected_build_option_origin: "recorded_bldopt" })),
    ).toBe(GENERIC);
  });

  it("leaves the existing rungs alone", () => {
    expect(rebuildFailureReason(rebuild("source_hash_mismatch"))).toBe("source_unreachable");
    expect(rebuildFailureReason(rebuild("manifest_path_escapes_source"))).toBe("policy_rejected");
    expect(rebuildFailureReason(rebuild("toolchain_probe_failed"))).toBe("internal_error");
    // A timeout outranks everything, including a named rejected option.
    expect(
      rebuildFailureReason(
        rebuild("recorded_build_option_unsupported", {
          timed_out: true,
          rejected_build_option: "--locked",
        }),
      ),
    ).toBe("build_timeout");
  });
});

describe("the value of a rejected option never reaches the submitter", () => {
  it("repeats only what the builder already stripped", () => {
    // The builder strips at the source (`argument-policy.ts:flagName`) so there is one owner for the rule.
    const detail = rebuildFailureDetail(
      rebuild("recorded_build_option_unsupported", {
        rejected_build_option: "--env",
        rejected_build_option_origin: "recorded_bldopt",
      }),
    );

    expect(detail).toContain("--env");
    expect(detail).not.toContain("=");
  });
});
