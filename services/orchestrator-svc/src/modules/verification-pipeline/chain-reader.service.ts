import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  parseContractMetaSections,
  planMetadataReplay,
  recordedToolchainPair,
  stellarNetworkArgs,
  VerificationTarget as VerificationTargetDto,
  type RecordedToolchainPair,
  type Sep58Metadata,
} from "@scvs/core";
import {
  byteSize,
  runCommand,
  sha256File,
  type CommandResult,
} from "@scvs/core/process";
import type { AppConfigService } from "../../config/configuration.js";

// Resolves the expected Wasm hash and SEP-58 build metadata *before* dispatching a build — same call made by
// services/verification-svc's own copy at src/preflight/chain-reader.ts.

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

@Injectable()
export class ChainReaderService {
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService
  ) {}

  async getWasmMetadata(
    target: VerificationTargetDto
  ): Promise<ChainLookupResult> {
    const stellar = this.configService.get("stellarCliPath", { infer: true });
    const artifactRoot = this.configService.get("artifactDir", { infer: true });
    const cliTimeoutMs = this.configService.get("cliTimeoutMs", { infer: true });
    const mainnetRpcUrl = this.configService.get("mainnetRpcUrl", { infer: true });
    await mkdir(artifactRoot, { recursive: true });
    const workdir = await mkdtemp(join(artifactRoot, "chain-"));
    const wasmPath = join(workdir, "target.wasm");

    const fetchCommand = [
      stellar,
      "contract",
      "fetch",
      ...(target.contract_id
        ? ["--id", target.contract_id]
        : ["--wasm-hash", target.wasm_hash || ""]),
      ...stellarNetworkArgs(target.network, mainnetRpcUrl),
      "--out-file",
      wasmPath,
    ];
    // This service never mirrored the CLI's output to its own stdout and never retained the command, and the
    // shared runner defaults to doing both for `builder`'s sake. Opting out keeps this call what it was.
    const fetch = await runCommand(fetchCommand, {
      timeout_ms: cliTimeoutMs,
      mirrorOutput: false,
      record: false,
    });
    if (fetch.exit_code !== 0) {
      return {
        ok: false,
        status: this.classifyFetchFailure(fetch),
        reason: "stellar_contract_fetch_failed",
        detail: this.summarizeCommandFailure(fetch),
        diagnostics: { mode: "stellar_cli", fetch },
      };
    }

    let parsed: {
      replay: ReturnType<typeof planMetadataReplay>;
      toolchainPair: RecordedToolchainPair | undefined;
    };
    try {
      parsed = await this.parseMetadata(wasmPath);
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
    const wasmHash = await sha256File(wasmPath);
    const wasmByteSize = await byteSize(wasmPath);

    return {
      ok: true,
      metadata: {
        wasm_hash: wasmHash,
        wasm_byte_size: wasmByteSize,
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

  private async parseMetadata(wasmPath: string) {
    try {
      const sections = parseContractMetaSections(await readFile(wasmPath));
      const replay = planMetadataReplay(sections);
      return {
        replay,
        toolchainPair: replay?.sep58.bldimg ? undefined : recordedToolchainPair(sections),
      };
    } catch (error) {
      throw new Error(
        `metadata_parse_failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private classifyFetchFailure(
    result: CommandResult
  ): "not_found" | "chain_lookup_failed" {
    const text =
      `${result.stdout}\n${result.stderr}\n${result.error || ""}`.toLowerCase();
    if (text.includes("not found") || text.includes("does not exist")) {
      return "not_found";
    }
    return "chain_lookup_failed";
  }

  private summarizeCommandFailure(result: CommandResult): string {
    if (result.error) {
      return result.error;
    }
    const text = (
      result.stderr ||
      result.stdout ||
      "Stellar CLI command failed."
    ).trim();
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  }
}
