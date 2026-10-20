import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AggregationRepository, TrustedVerifiersRepository } from "@scvs/db-query";
import {
  ScvsLogger,
  ownEntryOf,
  toResultUrl,
  type AgreementSummary,
  type UnavailableVerifier,
} from "@scvs/core";
import {
  InvalidWasmHashError,
  RegistryDocumentError,
  type SoveClient,
  type TrustedVerifier,
} from "soroban-verification-client";
import { toTrustedVerifier } from "../../common/tvl.js";
import { SoveClientFactory } from "../results/client-factory.service.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class AggregationSyncService {
  private readonly logger = new ScvsLogger("aggregation-sync");
  private firstPassComplete = false;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(AggregationRepository) private readonly aggregation: AggregationRepository,
    @Inject(TrustedVerifiersRepository) private readonly verifiers: TrustedVerifiersRepository,
    @Inject(SoveClientFactory) private readonly clients: SoveClientFactory,
  ) {}

  get hasCompletedFirstPass(): boolean {
    return this.firstPassComplete;
  }

  /** Not from a lifecycle hook: generate-openapi.ts initialises this app with no database. */
  start(): void {
    const intervalMs = this.configService.get("aggregationSyncIntervalMs", { infer: true });
    if (intervalMs <= 0) {
      this.logger.warn("aggregation sync disabled by configuration", { interval_ms: intervalMs });
      return;
    }
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll(): Promise<void> {
    await this.withdrawDisabled();
    const records = await this.verifiers.listTrustedVerifiers({ activeOnly: true });
    const verifiers = records
      .flatMap((record) => {
        try {
          return [toTrustedVerifier(record)];
        } catch (error) {
          this.logger.error("skipping malformed trusted_verifiers row", {
            verifier_id: record.verifierId,
            error: messageOf(error),
          });
          return [];
        }
      })
      .filter((verifier) => verifier.status === "active");

    for (const verifier of verifiers) {
      await this.syncOne(verifier);
    }
    this.firstPassComplete = true;
  }

  /** Runs every tick, so a member disabled by any path stops counting even if the seed never ran. */
  async withdrawDisabled(): Promise<void> {
    const records = await this.verifiers.listTrustedVerifiers();
    const now = new Date().toISOString();
    for (const record of records.filter((candidate) => candidate.status === "disabled")) {
      const withdrawn = await this.aggregation.withdrawVerifier({ verifierId: record.verifierId, now });
      if (withdrawn.length > 0) {
        this.logger.warn("withdrew a disabled verifier's retained results", {
          verifier_id: record.verifierId,
          wasm_hashes: withdrawn.length,
        });
      }
    }
  }

  async syncOne(verifier: TrustedVerifier): Promise<void> {
    const client = await this.clients.forVerifier(verifier);
    const now = new Date().toISOString();
    let failure: string | undefined;
    let failureReason: UnavailableVerifier["reason"] | undefined;

    const page = await this.discover(client, verifier);

    for (const wasmHash of page.hashes) {
      try {
        const document = await client.registry.statusObject(verifier, wasmHash);
        const entry = ownEntryOf(document.source_code_verifications, verifier.url);
        if (entry === undefined) {
          await this.aggregation.withdrawVerifierEntry({ verifierId: verifier.id, wasmHash, now });
          continue;
        }
        const fields = entry as unknown as Record<string, unknown>;
        await this.aggregation.recordVerifierEntry({
          verifierId: verifier.id,
          wasmHash,
          entry: {
            status: entry.status,
            schemaVersion: document.schema_version,
            ...(entry.verifier !== undefined ? { verifier: entry.verifier } : {}),
            ...(peerString(fields, "recipe_source") !== undefined
              ? { recipeSource: peerString(fields, "recipe_source") }
              : {}),
            ...(peerString(fields, "image_trust_level") !== undefined
              ? { imageTrustLevel: peerString(fields, "image_trust_level") }
              : {}),
            recipe: recipeOf(fields),
            ...(fields.verified_source_code_uris !== undefined
              ? { verifiedSourceCodeUris: fields.verified_source_code_uris }
              : {}),
            // Normalised: a draft-shape peer sends bare strings, and the aggregate types a link as an object.
            ...(entry.results_urls !== undefined
              ? { resultsUrls: entry.results_urls.map(toResultUrl) }
              : {}),
            ...(entry.processed_at !== undefined ? { processedAt: entry.processed_at } : {}),
          },
          retrievedAt: now,
          now,
        });
      } catch (error) {
        if (error instanceof InvalidWasmHashError) continue; // never a Wasm hash, so nothing to read or withdraw
        if (isNotFound(error)) {
          await this.aggregation.withdrawVerifierEntry({ verifierId: verifier.id, wasmHash, now });
          continue;
        }
        failure = messageOf(error);
        failureReason = classifyFailure(error);
        if (!(error instanceof RegistryDocumentError)) break; // unreachable: stop asking this tick
      }
    }

    // Advance only past a page read in full; on failure keep the old cursor so the page is retried.
    await this.aggregation.setCursor(
      verifier.id,
      failure === undefined ? page.cursor : page.previousCursor,
      failure ?? page.error,
      failureReason ?? page.errorReason,
    );
    const problem = failure ?? page.error;
    if (problem) this.logger.warn("verifier sync incomplete", { verifier_id: verifier.id, error: problem });
  }

  private async discover(
    client: SoveClient,
    verifier: TrustedVerifier,
  ): Promise<DiscoveryPage> {
    const stored = await this.aggregation.getCursor(verifier.id);
    const previousCursor = stored?.cursor;

    try {
      const page = await client.registry.bulkLoad(verifier, {
        ...(previousCursor !== undefined ? { cursor: previousCursor } : {}),
        limit: this.configService.get("bulkPageLimit", { infer: true }),
      });
      const last = page.records.at(-1);
      return {
        hashes: page.records.map((record) => record.wasm_hash),
        ...(page.cursor !== null
          ? { cursor: page.cursor }
          : last !== undefined
            ? { cursor: `${new Date(last.updated_at).getTime()}-${last.wasm_hash}` }
            : { cursor: previousCursor }),
        previousCursor,
      };
    } catch (error) {
      return { hashes: [], previousCursor, error: messageOf(error), errorReason: classifyFailure(error) };
    }
  }
}

/** `cursor === undefined` means "nothing to record, keep what you had". */
type DiscoveryPage = {
  hashes: string[];
  cursor?: string;
  previousCursor?: string;
  error?: string;
  errorReason?: UnavailableVerifier["reason"];
};

const ENTRY_FIELDS_WITH_THEIR_OWN_COLUMN = [
  "verifier",
  "status",
  "results_urls",
  "processed_at",
  "schema_version",
  "recipe_source",
  "image_trust_level",
  "verified_source_code_uris",
];

const FIELDS_WE_ADD_WHEN_SERVING = ["retrieved_at"];

/** Unknown peer fields must survive here: the read side serves only what this stores. */
function recipeOf(entry: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set([...ENTRY_FIELDS_WITH_THEIR_OWN_COLUMN, ...FIELDS_WE_ADD_WHEN_SERVING]);
  return Object.fromEntries(
    Object.entries(entry).filter(([field, value]) => !excluded.has(field) && value !== undefined),
  );
}

function peerString(entry: Record<string, unknown>, field: string): string | undefined {
  const value = entry[field];
  return typeof value === "string" ? value : undefined;
}

function classifyFailure(error: unknown): UnavailableVerifier["reason"] {
  if (error instanceof RegistryDocumentError) return "invalid_response";
  const message = messageOf(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("aborted")) {
    return "timeout";
  }
  // Messages the fetch policy throws when it refuses a destination before any request.
  if (message.includes("is not allowed") || message.includes("blocked")) return "refused";
  return "fetch_failed";
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AgreementSummary };
