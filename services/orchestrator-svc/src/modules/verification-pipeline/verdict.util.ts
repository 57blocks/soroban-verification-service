import type { RebuildRecord } from "@scvs/db";
import type { VerificationResultSummary as VerificationResultSummaryDto } from "@scvs/core";
import { recipeSourceFor } from "../publish/artifact-builder.util.js";

/**
 * Pure and stateless on purpose: it takes the already-fetched deployed hash rather than a `ChainReaderService`,
 * so the "must be freshly fetched" requirement is visible at each call site and the three cases (matched /
 * mismatched / drifted) are unit-testable without a chain or a database.
 */
export type ResolveVerdictInput = {
  rebuild: Pick<
    RebuildRecord,
    | "rebuiltWasmHash"
    | "buildMode"
    | "mechanismReason"
    | "diagnostics"
    | "verifyFailureCode"
    | "sourceCanonicalisation"
  >;
  /** The target's deployed hash, fetched *now*. */
  freshDeployedHash: string;
  /** What the job recorded as its target's hash when it was created, for drift comparison. */
  recordedHash?: string;
};

export type ResolvedVerdict = {
  matched: boolean;
  /** The deployed hash moved between submission and comparison — see `contract_binding_drifted`. */
  drifted: boolean;
  result: VerificationResultSummaryDto;
};

export function resolveJobVerdict(input: ResolveVerdictInput): ResolvedVerdict {
  const { rebuild, freshDeployedHash, recordedHash } = input;
  const rebuiltHash = rebuild.rebuiltWasmHash;
  const deployed = freshDeployedHash.toLowerCase();
  const matched = Boolean(rebuiltHash) && rebuiltHash?.toLowerCase() === deployed;
  const drifted = Boolean(recordedHash) && recordedHash?.toLowerCase() !== deployed;
  const reconstruction = sourceReconstructionOf(rebuild.sourceCanonicalisation);

  return {
    matched,
    drifted,
    result: {
      // Interim status; publish.service.ts settles it to verified/mismatch.
      status_summary: "running",
      // The hash this verdict is *about* is the one actually compared against, not the one filed at submission.
      wasm_hash: deployed,
      expected_wasm_hash: deployed,
      ...(rebuiltHash ? { rebuilt_wasm_hash: rebuiltHash } : {}),
      matched,
      ...(drifted ? { contract_binding_drifted: true } : {}),
      // Deriving it from `runner` was correct only while runner and provenance coincided, and retiring the CLI
      // mechanism ends that: every rebuild is now the sandbox, so a `runner`-derived label would publish
      // `retroactive_manual` for every cli-58 contract replaying the chain's own recipe.
      verification_path: publishedVerificationPath(rebuild),
      // Published unchanged for them.
      ...(rebuild.verifyFailureCode
        ? { verify_attempt_reason: rebuild.verifyFailureCode }
        : {}),
      ...(reconstruction ? { source_reconstruction: reconstruction } : {}),
      ...(rebuild.diagnostics
        ? { sandbox_diagnostics: rebuild.diagnostics as VerificationResultSummaryDto["sandbox_diagnostics"] }
        : {}),
    },
  };
}

/** Where this rebuild's *recipe* came from, as the published label states it — not which tool executed it. */
function publishedVerificationPath(
  rebuild: Pick<RebuildRecord, "mechanismReason">,
): "metadata_backed" | "retroactive_manual" {
  return recipeSourceFor(rebuild.mechanismReason) === "on_chain_metadata"
    ? "metadata_backed"
    : "retroactive_manual";
}

/** Three outcomes are published and two are not. */
function sourceReconstructionOf(
  record: unknown,
): VerificationResultSummaryDto["source_reconstruction"] {
  const reported = (record ?? {}) as { reconstruction?: string; reconstruction_detail?: string };
  const outcome = reported.reconstruction;
  if (outcome !== "adopted" && outcome !== "hash_mismatch" && outcome !== "failed") {
    return undefined;
  }
  return {
    outcome,
    ...(reported.reconstruction_detail ? { detail: reported.reconstruction_detail } : {}),
  };
}
