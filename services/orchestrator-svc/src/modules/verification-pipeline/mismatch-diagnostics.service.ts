import { readFile } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createS3Client, getObjectBytesBounded } from "@scvs/aws";
import { ScvsLogger, type BuildMode, type SandboxDiagnostics } from "@scvs/core";
import {
  describeWasmMismatch,
  inferMismatchCauses,
} from "../publish/wasm-compare.util.js";
import { rebuiltWasmKey } from "../../common/staging-keys.util.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Explains a mismatch, for the submitter who now has to find which of a dozen build inputs differed. */
@Injectable()
export class MismatchDiagnosticsService {
  private readonly logger = new ScvsLogger("mismatch-diagnostics");

  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  /**
   * Returns the job's `sandbox_diagnostics` with `wasm_compare`/`likely_causes` filled in, or `undefined` when
   * no explanation could be assembled — in which case the caller publishes what it had.
   */
  async describe(input: {
    rebuildId: string;
    buildMode: BuildMode;
    runner?: string;
    deployedWasmPath?: string;
    existing?: SandboxDiagnostics;
  }): Promise<SandboxDiagnostics | undefined> {
    const baseline = this.baselineDiagnostics(input.existing, input.runner);
    if (!baseline) {
      this.logger.warn("no runner recorded, so a mismatch cannot carry valid diagnostics", {
        rebuild_id: input.rebuildId,
      });
      return undefined;
    }

    const rebuilt = await this.fetchRebuiltBytes(input.rebuildId, input.buildMode);
    if (!rebuilt) return undefined;

    const deployed = await this.readDeployedBytes(input.deployedWasmPath);
    const wasmCompare = describeWasmMismatch(deployed, rebuilt);

    return {
      ...baseline,
      wasm_compare: wasmCompare,
      likely_causes: inferMismatchCauses(wasmCompare),
    };
  }

  /**
   * `runner` is the one required field, and `rebuild.runner` is a plain `string` in the database while the DTO
   * constrains it to two values.
   */
  private baselineDiagnostics(
    existing: SandboxDiagnostics | undefined,
    runner: string | undefined,
  ): SandboxDiagnostics | undefined {
    if (existing?.runner) return existing;
    if (runner === "stellar_contract_verify" || runner === "docker_build_image_rebuild") {
      return { ...(existing ?? {}), runner } as SandboxDiagnostics;
    }
    return undefined;
  }

  /**
   * The same object, key and ceiling the verdict's own hash came from — deliberately re-fetched rather than
   * threaded through from `RebuildOutcomeService`.
   */
  private async fetchRebuiltBytes(
    rebuildId: string,
    buildMode: BuildMode,
  ): Promise<Uint8Array | undefined> {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const maxBytes = this.configService.get("maxRebuiltWasmBytes", { infer: true });
    const key = rebuiltWasmKey(rebuildId, buildMode);

    try {
      const object = await getObjectBytesBounded(
        createS3Client({ region: staging.region }),
        staging.bucket,
        key,
        maxBytes,
      );
      if (!object || "tooLarge" in object) {
        // Both are unreachable in practice: a verdict only exists because these bytes were fetched and hashed
        // already.
        this.logger.warn("no rebuilt Wasm to explain the mismatch with", {
          rebuild_id: rebuildId,
          artifact_key: key,
          reason: object ? "too_large" : "absent",
        });
        return undefined;
      }
      return object.bytes;
    } catch (error) {
      this.logger.warn("could not fetch the rebuilt Wasm for mismatch diagnostics", {
        rebuild_id: rebuildId,
        artifact_key: key,
        error: error instanceof Error ? error : String(error),
      });
      return undefined;
    }
  }

  private async readDeployedBytes(path?: string): Promise<Uint8Array | undefined> {
    if (!path) return undefined;
    try {
      return await readFile(path);
    } catch (error) {
      // The CLI's workdir is a temp directory; losing it costs the deployed half of the diff and nothing else.
      this.logger.warn("could not read the deployed Wasm for mismatch diagnostics", {
        deployed_wasm_path: path,
        error: error instanceof Error ? error : String(error),
      });
      return undefined;
    }
  }
}
