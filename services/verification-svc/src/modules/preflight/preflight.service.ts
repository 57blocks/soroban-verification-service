import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { runPreflight, type ChainReaderConfig, type PreflightResult } from "./index.js";
import type { PreflightRequestDto } from "./preflight.dto.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class PreflightService {
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
