import { describe, expect, test } from "vitest";
import {
  bannerView,
  consoleStateToSubmissionState,
  getTargetSummary,
  troubleshootingMessage,
} from "@/features/verification/utils/result.util";

// The console's first tests.

// It is gone: the generated union requires `status` on both submit variants, so there is nothing left to infer.

describe("consoleStateToSubmissionState", () => {
  test("takes the status straight off an accepted submission", () => {
    expect(
      consoleStateToSubmissionState({
        phase: "accepted",
        response: {
          status: "incomplete",
          target: { network: "testnet" },
          missing_fields: [],
          available_fields: {},
          message: "",
        },
      }),
    ).toBe("incomplete");
  });

  test("a local failure displays as error, like the stream's own job_timeout", () => {
    expect(
      consoleStateToSubmissionState({
        phase: "failed",
        failure: { code: "network_error", detail: "unreachable" },
      }),
    ).toBe("error");
  });
});

describe("bannerView", () => {
  test("a rejection shows the verifier's code and sentence", () => {
    expect(
      bannerView({
        phase: "failed",
        failure: {
          code: "source_hash_mismatch",
          detail: "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
        },
      }),
    ).toMatchObject({
      code: "source_hash_mismatch",
      detail: "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
    });
  });

  test("the job stream's reason is the code — that is where `reason` actually comes from", () => {
    expect(
      bannerView({
        phase: "job",
        state: "error",
        response: { status: "error", reason: "job_timeout", detail: "stuck", job_id: "j1" },
      }),
    ).toMatchObject({ code: "job_timeout", detail: "stuck", jobId: "j1" });
  });

  // An accepted submission is not a failure, so it has no code to show — the old flat object made this
  // indistinguishable from "a failure whose code we failed to find".
  test("an accepted submission shows its message and no code", () => {
    const view = bannerView({
      phase: "accepted",
      response: {
        status: "queued",
        job_id: "j2",
        target: { network: "testnet", contract_id: "C1" },
        message: "Verification job created and queued for processing.",
      },
    });
    expect(view.code).toBeUndefined();
    expect(view.jobId).toBe("j2");
    expect(view.detail).toBe("Verification job created and queued for processing.");
  });
});

describe("getTargetSummary", () => {
  test("prefers contract_id over wasm_hash", () => {
    expect(getTargetSummary({ contract_id: "C123", wasm_hash: "ab" }).kind).toBe("Contract ID");
  });

  test("falls back to wasm_hash, then network, then a stable placeholder", () => {
    expect(getTargetSummary({ wasm_hash: "ab" }).kind).toBe("Wasm hash");
    expect(getTargetSummary({ network: "testnet" }).value).toBe("testnet");
    expect(getTargetSummary(undefined).value).toBe("Unknown target");
  });
});

describe("troubleshootingMessage", () => {
  test("a composition failure says it is the verifier's problem, not the submission's", () => {
    const message = troubleshootingMessage("build_failed", { reason: "smoke_test_failed" });
    expect(message).toContain("verifier's side");
    expect(message).not.toContain("manifest path");
  });

  test("every composition reason gets that copy, not the generic build advice", () => {
    for (const reason of [
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
    ]) {
      expect(troubleshootingMessage("build_failed", { reason })).not.toContain("manifest path");
    }
  });

  test("an ordinary build failure still gets the submission-focused advice", () => {
    // The generic copy is right when the rebuild actually ran, so the new branch must not swallow it.
    expect(troubleshootingMessage("build_failed", { reason: "build_error" })).toContain("manifest path");
    expect(troubleshootingMessage("build_failed", {})).toContain("manifest path");
  });

  test("sandbox_unavailable keeps its own more specific advice", () => {
    expect(troubleshootingMessage("build_failed", { reason: "sandbox_unavailable" })).toContain("Docker");
  });
});
