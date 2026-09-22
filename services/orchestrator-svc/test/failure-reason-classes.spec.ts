import { rebuildErrorCodeClass, rebuildErrorCodes, type RebuildErrorCodeClass } from "@scvs/core";
import { rebuildFailureReason } from "../src/modules/verification-pipeline/failure-reason.util.js";
import type { RebuildRecord } from "@scvs/db";

/**
 * The classes in `@scvs/core`'s `rebuildErrorCodeClass` are only worth having if this rung reads all of them.
 * Before the table, three parallel `Set`s here were the only record of which codes existed, and a code the
 * sandbox emitted but no set listed became a silent, non-retryable `build_failed`.
 */
const rebuild = (
  errorCode: string,
  diagnostics: Record<string, unknown> = {},
): RebuildRecord =>
  ({ rebuildId: "11111111-2222-3333-4444-555555555555", errorCode, diagnostics }) as unknown as RebuildRecord;

const REASON_OF_CLASS: Record<RebuildErrorCodeClass, string> = {
  source: "source_unreachable",
  policy: "policy_rejected",
  infrastructure: "internal_error",
  build: "build_failed",
};

describe("every code in the shared table", () => {
  it("maps to the failure reason its class names", () => {
    const wrong = rebuildErrorCodes
      .map((code) => ({ code, got: rebuildFailureReason(rebuild(code)) }))
      .filter(({ code, got }) => got !== REASON_OF_CLASS[rebuildErrorCodeClass[code]]);
    expect(wrong).toEqual([]);
  });

  it("covers all four classes, so no rung is dead", () => {
    expect(new Set(rebuildErrorCodes.map((code) => rebuildErrorCodeClass[code]))).toEqual(
      new Set(["source", "policy", "infrastructure", "build"]),
    );
  });
});

describe("the rungs keep their order", () => {
  it("a timeout wins over the code, whatever its class", () => {
    expect(rebuildFailureReason(rebuild("source_uri_missing", { timed_out: true }))).toBe("build_timeout");
    expect(rebuildFailureReason(rebuild("sandbox_unavailable", { timed_out: true }))).toBe("build_timeout");
  });

  it("a policy code is not reachable by the docker_error test below it", () => {
    // An inadmissible recipe is neither a source problem nor a machinery one, even inside a sandbox that also
    // reported a Docker fault.
    expect(rebuildFailureReason(rebuild("manifest_path_escapes_source", { docker_error: "no daemon" }))).toBe(
      "policy_rejected",
    );
  });

  it("a docker_error makes an ordinary build failure machinery", () => {
    expect(rebuildFailureReason(rebuild("rebuild_command_failed"))).toBe("build_failed");
    expect(rebuildFailureReason(rebuild("rebuild_command_failed", { docker_error: "no daemon" }))).toBe(
      "internal_error",
    );
  });

  it("an unknown code still falls through to the same two answers", () => {
    // A sandbox older or newer than this reader, and the `docker_error` string passed through in the code's
    // place, both arrive here.
    expect(rebuildFailureReason(rebuild("a_code_no_build_of_this_knows"))).toBe("build_failed");
    expect(
      rebuildFailureReason(rebuild("a_code_no_build_of_this_knows", { docker_error: "no daemon" })),
    ).toBe("internal_error");
  });
});
