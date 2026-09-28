import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { byteSize, runCommand, sha256File, type CommandResult } from "./process.js";
import { stellarNetworkArgs } from "./stellar-network.js";
import {
  parseContractMetaSections,
  planMetadataReplay,
  recordedToolchainPair,
  type Sep58Metadata,
} from "./wasm-metadata.js";
import type { RecordedToolchainPair } from "./build-environment.js";
import type { VerificationTarget } from "./target.js";

/** Node-only: not exported from the barrel; import `@scvs/core/chain-reader`. */

export type WasmMetadata = {
  wasm_hash: string;
  wasm_byte_size: number;
  sep58: Sep58Metadata;
  toolchain_pair?: RecordedToolchainPair;
  metadata_replay?: {
    section_index: number;
    entries: string[];
    dropped_keys: string[];
  };
  wasm_path?: string;
  diagnostics: {
    mode: "stellar_cli";
    fetch: CommandResult;
  };
};

export type ChainLookupResult =
  | { ok: true; metadata: WasmMetadata }
  | {
      ok: false;
      status: "not_found" | "chain_lookup_failed";
      reason: string;
      detail: string;
      diagnostics: Record<string, unknown>;
    };

export type ChainReaderConfig = {
  stellarCliPath: string;
  artifactDir: string;
  cliTimeoutMs: number;
  /** Unset keeps the CLI's built-in mainnet RPC, a placeholder that fails every mainnet fetch. */
  mainnetRpcUrl?: string;
};

export function buildFetchCommand(
  target: VerificationTarget,
  config: ChainReaderConfig,
  wasmPath: string,
): string[] {
  return [
    config.stellarCliPath,
    "contract",
    "fetch",
    ...(target.contract_id ? ["--id", target.contract_id] : ["--wasm-hash", target.wasm_hash || ""]),
    ...stellarNetworkArgs(target.network, config.mainnetRpcUrl),
    "--out-file",
    wasmPath,
  ];
}

export function classifyFetchFailure(result: CommandResult): "not_found" | "chain_lookup_failed" {
  const text = `${result.stdout}\n${result.stderr}\n${result.error || ""}`.toLowerCase();
  if (text.includes("not found") || text.includes("does not exist")) {
    return "not_found";
  }
  return "chain_lookup_failed";
}

export function summarizeCommandFailure(result: CommandResult): string {
  if (result.error) {
    return result.error;
  }
  const text = (result.stderr || result.stdout || "Stellar CLI command failed.").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

export async function getWasmMetadata(
  target: VerificationTarget,
  config: ChainReaderConfig,
): Promise<ChainLookupResult> {
  await mkdir(config.artifactDir, { recursive: true });
  const workdir = await mkdtemp(join(config.artifactDir, "chain-"));
  const wasmPath = join(workdir, "target.wasm");

  const fetchCommand = buildFetchCommand(target, config, wasmPath);
  const fetch = await runCommand(fetchCommand, {
    timeout_ms: config.cliTimeoutMs,
    mirrorOutput: false,
    record: false,
  });
  if (fetch.exit_code !== 0) {
    return {
      ok: false,
      status: classifyFetchFailure(fetch),
      reason: "stellar_contract_fetch_failed",
      detail: summarizeCommandFailure(fetch),
      diagnostics: { mode: "stellar_cli", fetch },
    };
  }

  let parsed: Awaited<ReturnType<typeof parseMetadata>>;
  try {
    parsed = await parseMetadata(wasmPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "chain_lookup_failed",
      reason: "metadata_parse_failed",
      detail,
      diagnostics: { mode: "stellar_cli", fetch, metadata_parse_error: detail },
    };
  }

  return {
    ok: true,
    metadata: {
      wasm_hash: await sha256File(wasmPath),
      wasm_byte_size: await byteSize(wasmPath),
      sep58: parsed.replay?.sep58 ?? { raw_entries: [] },
      ...(parsed.toolchainPair ? { toolchain_pair: parsed.toolchainPair } : {}),
      ...(parsed.replay
        ? {
            metadata_replay: {
              section_index: parsed.replay.section_index,
              entries: parsed.replay.metadata_replay,
              dropped_keys: parsed.replay.dropped_keys,
            },
          }
        : {}),
      wasm_path: wasmPath,
      diagnostics: {
        mode: "stellar_cli",
        fetch,
      },
    },
  };
}

async function parseMetadata(wasmPath: string) {
  try {
    const sections = parseContractMetaSections(await readFile(wasmPath));
    const replay = planMetadataReplay(sections);
    return {
      replay,
      toolchainPair: replay?.sep58.bldimg ? undefined : recordedToolchainPair(sections),
    };
  } catch (error) {
    throw new Error(`metadata_parse_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
