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

/** Never fetches: answers only from what the sync retained. */
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
    return assemble(wasmHash, served(entries, context), this.unavailableFor(context), context);
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
    for (const entry of served(cached, context)) {
      byHash.set(entry.wasmHash, [...(byHash.get(entry.wasmHash) ?? []), entry]);
    }

    const unavailable = this.unavailableFor(context);
    const records = rows.map((row) =>
      assemble(row.wasmHash, byHash.get(row.wasmHash) ?? [], unavailable, context),
    );
    const last = rows.at(-1);
    return {
      records,
      cursor: rows.length === opts.limit && last ? `${new Date(last.aggregationUpdatedAt).getTime()}-${last.wasmHash}` : null,
    };
  }

  private async assemblyContext(): Promise<AssemblyContext> {
    const [state, records] = await Promise.all([
      this.aggregation.listSyncState(),
      this.verifiers.listTrustedVerifiers(),
    ]);
    const active = records.filter((record) => record.status === "active");
    return {
      displayNames: new Map(
        records.map((record) => [record.verifierId, record.displayName ?? record.verifierId]),
      ),
      resultRoots: new Map(active.map((record) => [record.verifierId, record.resultsRoot])),
      knownVerifierIds: new Set(active.map((record) => record.verifierId)),
      disabledVerifierIds: new Set(
        records.filter((record) => record.status === "disabled").map((record) => record.verifierId),
      ),
      stateByVerifier: new Map(state.map((entry) => [entry.verifierId, entry])),
    };
  }

  private unavailableFor(context: AssemblyContext): UnavailableVerifier[] {
    const unavailable: UnavailableVerifier[] = [];
    for (const entry of context.stateByVerifier.values()) {
      if (entry.lastError === undefined) continue;
      if (!context.knownVerifierIds.has(entry.verifierId)) continue;
      unavailable.push({
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
  displayNames: Map<string, string>;
  resultRoots: Map<string, string>;
  knownVerifierIds: Set<string>;
  disabledVerifierIds: Set<string>;
  stateByVerifier: Map<string, VerifierSyncCursorRecord>;
};

/** A disabled member's retained entries are neither served nor counted; a paused member's still are. */
function served(
  cached: readonly VerifierResultCacheRecord[],
  context: AssemblyContext,
): VerifierResultCacheRecord[] {
  return cached.filter((record) => !context.disabledVerifierIds.has(record.verifierId));
}

/** Takes the whole context: `displayNames` and `resultRoots` share a type, so passing one map invites a mix-up. */
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

function toEntry(record: VerifierResultCacheRecord, resultRoot: string): AggregatedRegistryVerification {
  const recipe = (record.recipe ?? {}) as Record<string, unknown>;
  const verifier = (record.verifier as { url?: string; name?: string } | undefined) ?? { url: resultRoot };
  return {
    verifier: verifier.url !== undefined ? verifier : { ...verifier, url: resultRoot },
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

function unavailableReason(stored: string | undefined): UnavailableVerifier["reason"] {
  const known: readonly UnavailableVerifier["reason"][] = ["fetch_failed", "invalid_response", "timeout", "refused"];
  return known.find((reason) => reason === stored) ?? "fetch_failed";
}
