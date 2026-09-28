import { Inject, Injectable } from "@nestjs/common";
import { TrustedVerifiersRepository } from "@scvs/db-query";
import { newClient, type ResolvedVerifier, type SoveClient, type TrustedVerifier } from "soroban-verification-client";
import { canPin } from "@scvs/core/pinned-fetch";
import { RESULT_FETCH_FACTORY, type ResultFetchFactory } from "./result-fetch-factory.js";
import {
  loadTrustedVerifiersList,
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
} from "../../common/tvl.js";
import type { AppConfigService } from "../../config/configuration.js";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class SoveClientFactory {
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(TrustedVerifiersRepository) private readonly verifiers: TrustedVerifiersRepository,
    @Inject(RESULT_FETCH_FACTORY) private readonly fetchFactory: ResultFetchFactory,
  ) {}

  async forCurrentTvl(): Promise<{ client: SoveClient; verifiers: readonly ResolvedVerifier[] }> {
    const tvl = await loadTrustedVerifiersList(this.verifiers, { activeOnly: true });
    const policy = this.policy();
    const client = newClient({
      tvl,
      timeoutMs: this.configService.get("queryTimeoutMs", { infer: true }),
      fetchFactory: this.fetchFactoryFor(policy),
      ...(policy ? { policy } : {}),
    });
    return { client, verifiers: client.verifiers };
  }

  async forVerifier(verifier: TrustedVerifier): Promise<SoveClient> {
    const policy = this.policy();
    return newClient({
      tvl: {
        schema: TRUSTED_VERIFIERS_LIST_SCHEMA,
        schema_version: TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
        verifiers: [verifier],
        updated_at: new Date().toISOString(),
      },
      timeoutMs: this.configService.get("queryTimeoutMs", { infer: true }),
      fetchFactory: this.fetchFactoryFor(policy),
      ...(policy ? { policy } : {}),
    });
  }

  private policy(): { allowedSchemes: string[]; blockPrivateRanges: boolean } | undefined {
    return this.configService.get("allowInsecureResultRoots", { infer: true })
      ? { allowedSchemes: ["https:", "http:"], blockPrivateRanges: false }
      : undefined;
  }

  private fetchFactoryFor(policy: { allowedSchemes: string[] } | undefined): ResultFetchFactory {
    if (policy !== undefined && !canPin(policy)) return () => globalThis.fetch;
    return this.fetchFactory;
  }
}
