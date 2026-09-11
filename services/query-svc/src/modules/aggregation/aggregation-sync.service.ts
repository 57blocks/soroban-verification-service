import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AggregationRepository, TrustedVerifiersRepository } from "@scvs/db-query";
import {
  ScvsLogger,
  isSameVerifier,
  type AgreementSummary,
  type PeerRegistryStatusObject,
  type PeerRegistryVerification,
  type UnavailableVerifier,
} from "@scvs/core";
import { RegistryDocumentError, type SoveClient, type TrustedVerifier } from "@scvs/sdk";
import { toTrustedVerifier } from "../../common/tvl.js";
import { SoveClientFactory } from "../results/client-factory.service.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Keeps the retained aggregation current. */
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

  /** False until every active verifier has been attempted once. */
  get hasCompletedFirstPass(): boolean {
    return this.firstPassComplete;
  }

  /**
   * Called from the serving entrypoint, not from a lifecycle hook: `generate-openapi.ts` initialises this same
   * application with no database, so anything starting at `onApplicationBootstrap` would make document
   * generation depend on Postgres.
   */
  start(): void {
    const intervalMs = this.configService.get("aggregationSyncIntervalMs", { infer: true });
    if (intervalMs <= 0) {
      // A deployment that syncs on a schedule of its own, or a test.
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

  /** One pass over every active verifier. Never throws: a pass that fails is retried next tick. */
  async syncAll(): Promise<void> {
    const records = await this.verifiers.listTrustedVerifiers({ activeOnly: true });
    const verifiers = records
      .flatMap((record) => {
        try {
          return [toTrustedVerifier(record)];
        } catch (error) {
          // This loop must not let one bad row abort every other verifier's sync for the tick, so skip it and
          // say why, loudly.
          this.logger.error("skipping malformed trusted_verifiers row", {
            verifier_id: record.verifierId,
            error: messageOf(error),
          });
          return [];
        }
      })
      .filter((verifier) => verifier.status === "active");

    // Every verifier's hash set comes from its own bulk-load stream (syncOne()/discover(), forward-only cursor)
    // — see decisions/static-only-tvl-membership-is-foreclosed-again.md.
    for (const verifier of verifiers) {
      await this.syncOne(verifier);
    }
    this.firstPassComplete = true;
  }

  /**
   * One verifier, every known hash. Note what that means for a peer serving a document we cannot parse: the
   * rows stay and go stale, and the verifier surfaces under `unavailable_verifiers`. Nothing is withdrawn.
   */
  async syncOne(verifier: TrustedVerifier): Promise<void> {
    const client = await this.clients.forVerifier(verifier);
    const now = new Date().toISOString();
    let failure: string | undefined;
    let failureReason: UnavailableVerifier["reason"] | undefined;

    const page = await this.discover(client, verifier);

    for (const wasmHash of page.hashes) {
      try {
        const document = await client.registry.statusObject(verifier, wasmHash);
        const entry = ownEntryOf(document, verifier);
        if (entry === undefined) {
          // The peer answered, and the answer holds no entry for this hash: a withdrawal, not a transport
          // problem.
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
            // The peer's own identity block, kept verbatim beside the TVL's attribution (CV11).
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
            ...(entry.results_urls !== undefined ? { resultsUrls: entry.results_urls } : {}),
            ...(entry.processed_at !== undefined ? { processedAt: entry.processed_at } : {}),
          },
          retrievedAt: now,
          now,
        });
      } catch (error) {
        if (isNotFound(error)) {
          // Same as an empty document: the peer has nothing here, authoritatively.
          await this.aggregation.withdrawVerifierEntry({ verifierId: verifier.id, wasmHash, now });
          continue;
        }
        // A malformed document is the peer's problem and is worth naming, but it is not a reason to stop
        // reading the rest of their hashes.
        failure = messageOf(error);
        failureReason = classifyFailure(error);
        if (!(error instanceof RegistryDocumentError)) break; // unreachable: stop asking this tick
      }
    }

    // The position only advances past a page read in full; a failure keeps the old one so the next tick retries
    // the same page rather than stepping over records it never saw.
    await this.aggregation.setCursor(
      verifier.id,
      failure === undefined ? page.cursor : page.previousCursor,
      failure ?? page.error,
      failureReason ?? page.errorReason,
    );
    const problem = failure ?? page.error;
    if (problem) this.logger.warn("verifier sync incomplete", { verifier_id: verifier.id, error: problem });
  }

  /** One page of a peer's own bulk-load stream, resumed from where we left off. */
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
        // A server-reported cursor always wins when present (BL4: it means more to read).
        ...(page.cursor !== null
          ? { cursor: page.cursor }
          : last !== undefined
            ? { cursor: `${new Date(last.updated_at).getTime()}-${last.wasm_hash}` }
            : { cursor: previousCursor }),
        previousCursor,
      };
    } catch (error) {
      // Classified here, not left to the caller's `fetch_failed` default: a discovery failure is the one that
      // empties the page, so the per-hash loop never runs and never classifies anything.
      return { hashes: [], previousCursor, error: messageOf(error), errorReason: classifyFailure(error) };
    }
  }
}

/** What one tick of discovery produced. `cursor === undefined` means "nothing to record, keep what you had". */
type DiscoveryPage = {
  hashes: string[];
  cursor?: string;
  previousCursor?: string;
  error?: string;
  errorReason?: UnavailableVerifier["reason"];
};

/** The fields that do not belong in `recipe` because the row already has a column for them. */
const ENTRY_FIELDS_WITH_THEIR_OWN_COLUMN = [
  "verifier",
  "status",
  "results_urls",
  "processed_at",
  // Ours records the *document* version this entry came from (CV11).
  "schema_version",
  // `out_of_band` and the singular `verified_source_code_uri` left this list in the same change: they are
  // fields we no longer emit, so they belong in `recipe`'s keep-everything-else bucket, which relays a peer
  // still on the draft's shape unchanged (CV8) without a column that would only ever hold someone else's
  // vocabulary.
  "recipe_source",
  "image_trust_level",
  "verified_source_code_uris",
  // The bug this fixes: listing it as a field WE add meant `recipeOf` excluded it on the way IN, while nothing
  // on the way OUT ever supplied it, so `verified_source_code_uri` was stripped from every peer document and
  // never restored.
];

/** Fields WE add on the way out. */
const FIELDS_WE_ADD_WHEN_SERVING = ["retrieved_at"];

/**
 * CV8 requires unknown fields to survive being *cached*, not only forwarded, and `/api/query/v1/*` serves what
 * this function stored: `AggregationReadService` never fetches, so whatever is dropped here is gone from the
 * served answer.
 */
function recipeOf(entry: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set([...ENTRY_FIELDS_WITH_THEIR_OWN_COLUMN, ...FIELDS_WE_ADD_WHEN_SERVING]);
  return Object.fromEntries(
    Object.entries(entry).filter(([field, value]) => !excluded.has(field) && value !== undefined),
  );
}

/** The entry belonging to the verifier whose root we just read. */
function ownEntryOf(
  document: PeerRegistryStatusObject,
  verifier: TrustedVerifier,
): PeerRegistryVerification | undefined {
  const entries = document.source_code_verifications;
  const own = { name: verifier.display_name, url: trimSlash(verifier.url) };
  const matched = entries.find(
    (entry) => entry.verifier?.url !== undefined && isSameVerifier({ ...entry.verifier, url: trimSlash(entry.verifier.url) }, own),
  );
  if (matched) return matched;
  return entries.some((entry) => entry.verifier?.url !== undefined) ? undefined : entries[0];
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** A string field we recognise, read off the untyped entry. */
function peerString(entry: Record<string, unknown>, field: string): string | undefined {
  const value = entry[field];
  return typeof value === "string" ? value : undefined;
}

/** AB6's `reason`, as far as this side can tell them apart. */
function classifyFailure(error: unknown): UnavailableVerifier["reason"] {
  if (error instanceof RegistryDocumentError) return "invalid_response";
  const message = messageOf(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("aborted")) {
    return "timeout";
  }
  // The fetch policy refuses a destination before any request is made — a decision of ours, not a failure of
  // theirs, and the one reason a consumer can act on by talking to us.
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
