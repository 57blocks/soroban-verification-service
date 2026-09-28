import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VerificationTarget as VerificationTargetDto } from "@scvs/core";
import {
  getWasmMetadata,
  type ChainLookupResult,
  type ChainReaderConfig,
} from "@scvs/core/chain-reader";
import type { AppConfigService } from "../../config/configuration.js";

export type { ChainLookupResult, WasmMetadata } from "@scvs/core/chain-reader";

@Injectable()
export class ChainReaderService {
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  async getWasmMetadata(target: VerificationTargetDto): Promise<ChainLookupResult> {
    return getWasmMetadata(target, this.config());
  }

  private config(): ChainReaderConfig {
    const mainnetRpcUrl = this.configService.get("mainnetRpcUrl", { infer: true });
    return {
      stellarCliPath: this.configService.get("stellarCliPath", { infer: true }),
      artifactDir: this.configService.get("artifactDir", { infer: true }),
      cliTimeoutMs: this.configService.get("cliTimeoutMs", { infer: true }),
      ...(mainnetRpcUrl ? { mainnetRpcUrl } : {}),
    };
  }
}
