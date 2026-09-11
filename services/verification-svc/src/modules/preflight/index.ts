import type { VerificationTarget } from "@scvs/core";
import { classifyPreflightBuildEnvironment, type PreflightBuildEnvironment } from "./build-environment.js";
import { getWasmMetadata, type ChainReaderConfig } from "./chain-reader.js";

export * from "./build-environment.js";
export * from "./chain-reader.js";
export * from "./manifest.js";
export * from "./policy.js";

export type PreflightResult =
  | {
      ok: true;
      target: VerificationTarget;
      wasm_hash: string;
      wasm_byte_size: number;
      available_fields: Record<string, string>;
      missing_fields: string[];
      suggested_manifest: Record<string, unknown> | null;
      prefill: Record<string, unknown>;
      build_environment: PreflightBuildEnvironment;
    }
  | {
      ok: false;
      status: "not_found" | "chain_lookup_failed";
      reason: string;
      detail: string;
    };

export async function runPreflight(target: VerificationTarget, config: ChainReaderConfig): Promise<PreflightResult> {
  const lookup = await getWasmMetadata(target, config);
  if (!lookup.ok) {
    return lookup;
  }

  const metadata = lookup.metadata;
  const sep58 = metadata.sep58;
  const resolvedTarget: VerificationTarget = {
    ...target,
    wasm_hash: metadata.wasm_hash || target.wasm_hash,
  };

  const availableFields: Record<string, string> = {};
  for (const entry of sep58.raw_entries ?? []) {
    if (entry.value) availableFields[entry.key] = entry.value;
  }
  if (metadata.toolchain_pair) {
    availableFields.cliver = metadata.toolchain_pair.cliver;
    availableFields.rsver = metadata.toolchain_pair.rsver;
  }
  if (sep58.bldimg) availableFields.bldimg = sep58.bldimg;
  if (sep58.bldarg?.length) availableFields.bldarg = sep58.bldarg.join(" ");
  if (sep58.bldopt?.length) availableFields.bldopt = sep58.bldopt.join(" ");
  if (sep58.source_sha256) availableFields.source_sha256 = sep58.source_sha256;
  if (sep58.source_uri) availableFields.source_uri = sep58.source_uri;

  const missingFields: string[] = [];
  if (!sep58.source_sha256) missingFields.push("source_sha256");
  if (!sep58.source_uri) missingFields.push("source_uri");

  const buildEnvironment = classifyPreflightBuildEnvironment(
    sep58,
    metadata.toolchain_pair,
  );

  const suggestedManifest = sep58.bldimg && sep58.source_sha256 && sep58.source_uri
    ? {
        schema: "stellar-submitted-source-verification-manifest-v1",
        target: resolvedTarget,
        bldimg: sep58.bldimg,
        ...(sep58.bldarg?.length && { bldarg: sep58.bldarg }),
        ...(sep58.bldopt?.length && { bldopt: sep58.bldopt }),
        source_sha256: sep58.source_sha256,
        source_uri: sep58.source_uri,
      }
    : null;

  return {
    ok: true,
    target: resolvedTarget,
    wasm_hash: metadata.wasm_hash,
    wasm_byte_size: metadata.wasm_byte_size,
    available_fields: availableFields,
    missing_fields: missingFields,
    suggested_manifest: suggestedManifest,
    build_environment: buildEnvironment,
    prefill: {
      schema: "stellar-submitted-source-verification-prefill-v1",
      target: resolvedTarget,
      metadata_prefill: {
        source: "wasm_metadata",
        available_fields: availableFields,
        missing_fields: missingFields,
      },
    },
  };
}
