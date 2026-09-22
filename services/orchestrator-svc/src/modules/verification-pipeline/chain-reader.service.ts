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

/**
 * This service's `ConfigService` wrapper around the shared chain reader (`@scvs/core/chain-reader`), which
 * `verification-svc` calls with a plain config object instead. The class stays because it is the DI boundary
 * the pipeline injects and the seam `pipeline-e2e.spec.ts` stubs; the reading itself is no longer here.
 */
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
