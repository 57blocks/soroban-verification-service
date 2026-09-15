import { Inject, Injectable } from "@nestjs/common";
import { TrustedVerifiersRepository } from "@scvs/db-query";
import { newClient, type ResolvedVerifier, type SoveClient, type TrustedVerifier } from "soroban-verification-client";
import { RESULT_FETCH_FACTORY, type ResultFetchFactory } from "./result-fetch-factory.js";
import {
  loadTrustedVerifiersList,
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
} from "../../common/tvl.js";
import type { AppConfigService } from "../../config/configuration.js";
import { ConfigService } from "@nestjs/config";

/**
 * Builds an SDK client over the current list. A fresh read per call, so flipping a verifier's `enabled` lands
 * on the next uncached query rather than at the next restart.
 */
@Injectable()
export class SoveClientFactory {
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(TrustedVerifiersRepository) private readonly verifiers: TrustedVerifiersRepository,
    @Inject(RESULT_FETCH_FACTORY) private readonly fetchFactory: ResultFetchFactory,
  ) {}

  /**
   * `ResolvedVerifier`, not `TrustedVerifier`: these are the client's own resolved entries, and the client
   * models what a list may legally carry — `manifest_url` optional — rather than what our table always does.
   */
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

  /** One verifier's own client, for the sync path — which always knows whose entry it is reading. */
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
      // Pinned by default (RESULT_FETCH_FACTORY, aggregation.module.ts) so a TVL entry's host cannot rebind
      // between this check and the request that follows it (packages/core's pinningLookup). The sync path is
      // exactly the loop that repeats this request every SCVS_AGGREGATION_SYNC_INTERVAL_MS, so it is the path
      // DNS rebinding actually targets.
      fetchFactory: this.fetchFactoryFor(policy),
      ...(policy ? { policy } : {}),
    });
  }

  /** A local dev root on plain http needs both relaxations, and asks for them by name. */
  private policy(): { allowedSchemes: string[]; blockPrivateRanges: boolean } | undefined {
    return this.configService.get("allowInsecureResultRoots", { infer: true })
      ? { allowedSchemes: ["https:", "http:"], blockPrivateRanges: false }
      : undefined;
  }

  /**
   * The pinned transport (`createPinnedFetch`) only ever issues `https.request`, so an `allowedSchemes`
   * admitting `http:` — the `allowInsecureResultRoots` relaxation above — cannot use it: an `http:` request
   * would be refused at construction (see `createPinnedFetch`'s own guard), not merely left unpinned. That
   * relaxation already accepts an unauthenticated local dev root, so falling back to a plain, unpinned fetch
   * here costs it nothing it was not already giving up.
   */
  private fetchFactoryFor(policy: { allowedSchemes: string[] } | undefined): ResultFetchFactory {
    if (policy?.allowedSchemes.some((scheme) => scheme !== "https:")) return () => globalThis.fetch;
    return this.fetchFactory;
  }
}
