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

/**
 * Reading a deployed contract's Wasm and its SEP-58 build metadata off the chain — the one implementation.
 *
 * `verification-svc` asks before accepting a submission and `orchestrator-svc` asks again before dispatching a
 * build, and each held a copy. The copies were the same reader in two wrappers: plain functions taking a
 * config object on one side, a Nest `@Injectable()` reading the same four values from `ConfigService` on the
 * other. The orchestrator's own header said as much.
 *
 * What made the duplication worth removing is not the line count but what it duplicated: the
 * `stellar contract fetch` argument list, including which network flags a target gets. Only one copy had
 * pulled that out where a test could reach it.
 *
 * Node-only, so **not exported from this package's barrel** — reach it at `@scvs/core/chain-reader`.
 */

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

/** What the reader needs, however the caller's service happens to hold it. */
export type ChainReaderConfig = {
  stellarCliPath: string;
  artifactDir: string;
  cliTimeoutMs: number;
  /**
   * Mainnet RPC endpoint (`SCVS_MAINNET_RPC_URL`). Optional: unset keeps the CLI's built-in mainnet entry,
   * which is a docs placeholder that fails any mainnet fetch.
   */
  mainnetRpcUrl?: string;
};

/**
 * The full `stellar contract fetch` invocation. Exported so the network-argument rules are directly
 * unit-testable without shelling out — which was true of one copy and not the other.
 */
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

/** A fetch that failed because the target is not there, told apart from one that failed for any other reason. */
export function classifyFetchFailure(result: CommandResult): "not_found" | "chain_lookup_failed" {
  const text = `${result.stdout}\n${result.stderr}\n${result.error || ""}`.toLowerCase();
  if (text.includes("not found") || text.includes("does not exist")) {
    return "not_found";
  }
  return "chain_lookup_failed";
}

/** What the submitter is told. Bounded, because CLI output can be long and reaches an API response. */
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
  // Neither service mirrored the CLI's output to its own stdout, nor retained the command; the shared runner
  // defaults to both for `builder`'s sake, so both are declined here.
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
