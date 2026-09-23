import { Inject, Injectable } from "@nestjs/common";
import {
  AggregationRepository,
  TrustedVerifiersRepository,
  type VerifierResultCacheRecord,
  type VerifierSyncCursorRecord,
} from "@scvs/db-query";
import {
  aggregateEnvelope,
  registryStatusOrUnverified,
  type AggregatedRegistryVerification,
  type AggregatedWasmStatus,
  type BulkOrder,
  type UnavailableVerifier,
} from "@scvs/core";

/**
 * Assembles an aggregate from what the sync retained. Never fetches: a bulk-load page must not be delayed by a
 * slow verifier (AB6), and the single-hash route answers from the same material so the two cannot disagree.
 */
@Injectable()
export class AggregationReadService {
  constructor(
    @Inject(AggregationRepository) private readonly aggregation: AggregationRepository,
    @Inject(TrustedVerifiersRepository) private readonly verifiers: TrustedVerifiersRepository,
  ) {}

  async byHash(wasmHash: string): Promise<AggregatedWasmStatus> {
    const [entries, context] = await Promise.all([
      this.aggregation.listCachedEntriesForHash(wasmHash),
      this.assemblyContext(),
    ]);
    return assemble(wasmHash, entries, this.unavailableFor(context), context);
  }

  async page(opts: {
    cursor?: { timestampMs: number; wasmHash: string };
    order: BulkOrder;
    limit: number;
  }): Promise<{ records: AggregatedWasmStatus[]; cursor: string | null }> {
    const rows = await this.aggregation.listAggregationIndex(opts);
    const [cached, context] = await Promise.all([
      this.aggregation.listCachedEntriesForHashes(rows.map((row) => row.wasmHash)),
      this.assemblyContext(),
    ]);

    const byHash = new Map<string, VerifierResultCacheRecord[]>();
    for (const entry of cached) {
      byHash.set(entry.wasmHash, [...(byHash.get(entry.wasmHash) ?? []), entry]);
    }

    const unavailable = this.unavailableFor(context);
    const records = rows.map((row) =>
      assemble(row.wasmHash, byHash.get(row.wasmHash) ?? [], unavailable, context),
    );
    const last = rows.at(-1);
    return {
      records,
      // A short page is the end of the stream (BL4/AB3), and only then is the cursor null.
      cursor: rows.length === opts.limit && last ? `${new Date(last.aggregationUpdatedAt).getTime()}-${last.wasmHash}` : null,
    };
  }

  /**
   * The two reads every assembly shares: the whole TVL (to know who is enabled and what each member is
   * *called*) and every verifier's sync state.
   */
  private async assemblyContext(): Promise<AssemblyContext> {
    const [state, records] = await Promise.all([
      this.aggregation.listSyncState(),
      this.verifiers.listTrustedVerifiers(),
    ]);
    const active = records.filter((record) => record.status === "active");
    return {
      // The fallback below is the honest one and the only one left: a member the seeded document named no
      // `display_name` for reads back under its id.
      displayNames: new Map(
        records.map((record) => [record.verifierId, record.displayName ?? record.verifierId]),
      ),
      resultRoots: new Map(active.map((record) => [record.verifierId, record.resultsRoot])),
      knownVerifierIds: new Set(active.map((record) => record.verifierId)),
      stateByVerifier: new Map(state.map((entry) => [entry.verifierId, entry])),
    };
  }

  /** Verifiers whose absence from this hash's answer has to be named rather than left silent. */
  private unavailableFor(context: AssemblyContext): UnavailableVerifier[] {
    const unavailable: UnavailableVerifier[] = [];
    for (const entry of context.stateByVerifier.values()) {
      if (entry.lastError === undefined) continue;
      if (!context.knownVerifierIds.has(entry.verifierId)) continue;
      unavailable.push({
        // AB6: the classification the sync recorded beside the message.
        url: context.resultRoots.get(entry.verifierId) ?? entry.verifierId,
        ...(context.displayNames.has(entry.verifierId)
          ? { name: context.displayNames.get(entry.verifierId)! }
          : {}),
        reason: unavailableReason(entry.lastErrorReason),
        ...(entry.lastError !== undefined ? { error: entry.lastError } : {}),
      });
    }
    return unavailable;
  }
}

type AssemblyContext = {
  /** Every TVL member's operator-facing name, keyed by id — active or not. */
  displayNames: Map<string, string>;
  /** Result root per verifier id — the identity an `unavailable_verifiers` entry is named by. */
  resultRoots: Map<string, string>;
  knownVerifierIds: Set<string>;
  stateByVerifier: Map<string, VerifierSyncCursorRecord>;
};

/**
 * `context` rather than the one map this needs: `displayNames` and `resultRoots` are both `Map<string,
 * string>`, so a caller passing the wrong one type-checks and serves a display name in the field that
 * identifies a verifier.
 */
function assemble(
  wasmHash: string,
  cached: readonly VerifierResultCacheRecord[],
  unavailable: readonly UnavailableVerifier[],
  context: AssemblyContext,
): AggregatedWasmStatus {
  return aggregateEnvelope({
    wasmHash,
    entries: cached.map((record) =>
      toEntry(record, context.resultRoots.get(record.verifierId) ?? record.verifierId),
    ),
    unavailableVerifiers: unavailable,
  });
}

/** One retained entry, relayed. Every retained entry carries its retrieval time; a live one never does (AB5). */
function toEntry(record: VerifierResultCacheRecord, resultRoot: string): AggregatedRegistryVerification {
  const recipe = (record.recipe ?? {}) as Record<string, unknown>;
  const verifier = (record.verifier as { url?: string; name?: string } | undefined) ?? { url: resultRoot };
  return {
    verifier: verifier.url !== undefined ? verifier : { ...verifier, url: resultRoot },
    // CV10: a status we do not recognise is shown as `unverified`, not passed through.
    status: registryStatusOrUnverified(record.status),
    ...(record.recipeSource !== undefined ? { recipe_source: record.recipeSource } : {}),
    ...(record.imageTrustLevel !== undefined ? { image_trust_level: record.imageTrustLevel } : {}),
    // Spread first, then re-apply the fields with columns of their own.
    ...(recipe as object),
    ...(record.verifiedSourceCodeUris !== undefined
      ? { verified_source_code_uris: record.verifiedSourceCodeUris }
      : {}),
    ...(record.resultsUrls !== undefined ? { results_urls: record.resultsUrls } : {}),
    ...(record.processedAt !== undefined ? { processed_at: record.processedAt } : {}),
    ...(record.schemaVersion !== undefined ? { schema_version: record.schemaVersion } : {}),
    retrieved_at: record.retrievedAt,
  } as AggregatedRegistryVerification;
}

/** One of AB6's four, or `fetch_failed` for a row that predates the column or names something else. */
function unavailableReason(stored: string | undefined): UnavailableVerifier["reason"] {
  const known: readonly UnavailableVerifier["reason"][] = ["fetch_failed", "invalid_response", "timeout", "refused"];
  return known.find((reason) => reason === stored) ?? "fetch_failed";
}
