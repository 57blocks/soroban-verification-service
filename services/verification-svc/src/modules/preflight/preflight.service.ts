import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { runPreflight, type ChainReaderConfig, type PreflightResult } from "./index.js";
import type { PreflightRequestDto } from "./preflight.dto.js";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * Also the one place in this call chain that's actually Nest-managed, so it's where `ConfigService` is injected
 * and turned into the plain `ChainReaderConfig` object threaded down into `runPreflight`/`getWasmMetadata`
 * (neither of which is a Nest class and so can't inject `ConfigService` themselves).
 */
@Injectable()
export class PreflightService {
  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  run(body: PreflightRequestDto): Promise<PreflightResult> {
    return runPreflight(
      {
        network: body.network,
        contract_id: body.contract_id,
        wasm_hash: body.wasm_hash,
      },
      this.chainReaderConfig(),
    );
  }

  private chainReaderConfig(): ChainReaderConfig {
    return {
      stellarCliPath: this.configService.get("stellarCliPath", { infer: true }),
      artifactDir: this.configService.get("artifactDir", { infer: true }),
      cliTimeoutMs: this.configService.get("cliTimeoutMs", { infer: true }),
      mainnetRpcUrl: this.configService.get("mainnetRpcUrl", { infer: true }),
    };
  }
}
