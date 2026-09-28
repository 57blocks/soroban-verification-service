import type { RebuildRecord } from "@scvs/db";
import type { VerificationResultSummary as VerificationResultSummaryDto } from "@scvs/core";
import { recipeSourceFor } from "../publish/index.js";

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
  freshDeployedHash: string;
  recordedHash?: string;
};

export type ResolvedVerdict = {
  matched: boolean;
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
      status_summary: "running",
      wasm_hash: deployed,
      expected_wasm_hash: deployed,
      ...(rebuiltHash ? { rebuilt_wasm_hash: rebuiltHash } : {}),
      matched,
      ...(drifted ? { contract_binding_drifted: true } : {}),
      // Derived from recipe provenance, not runner: every rebuild runs in the sandbox.
      verification_path: publishedVerificationPath(rebuild),
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

function publishedVerificationPath(
  rebuild: Pick<RebuildRecord, "mechanismReason">,
): "metadata_backed" | "retroactive_manual" {
  return recipeSourceFor(rebuild.mechanismReason) === "on_chain_metadata"
    ? "metadata_backed"
    : "retroactive_manual";
}

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
