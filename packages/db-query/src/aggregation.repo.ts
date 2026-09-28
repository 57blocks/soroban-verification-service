import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

export type AggregationCursor = { timestampMs: number; wasmHash: string };
export type SortOrder = "asc" | "desc";

export type VerifierResultCacheRecord = {
  verifierId: string;
  wasmHash: string;
  status: string;
  schemaVersion?: string;
  verifier?: unknown;
  recipeSource?: string;
  imageTrustLevel?: string;
  recipe?: unknown;
  verifiedSourceCodeUris?: unknown;
  resultsUrls?: unknown;
  processedAt?: string;
  retrievedAt: string;
};

export type VerifierSyncCursorRecord = {
  verifierId: string;
  cursor?: string;
  updatedAt?: string;
  lastError?: string;
  lastErrorReason?: string;
};

export type AggregationIndexRecord = { wasmHash: string; aggregationUpdatedAt: string };

@Injectable()
export class AggregationRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async getCursor(verifierId: string): Promise<VerifierSyncCursorRecord | undefined> {
    const row = await this.prisma.verifierSyncCursor.findUnique({ where: { verifierId } });
    return row ? toCursorRecord(row) : undefined;
  }

  async setCursor(
    verifierId: string,
    cursor: string | undefined,
    lastError?: string,
    lastErrorReason?: string,
  ): Promise<void> {
    const data = {
      cursor: cursor ?? null,
      updatedAt: new Date(),
      lastError: lastError ?? null,
      lastErrorReason: lastError === undefined ? null : (lastErrorReason ?? null),
    };
    await this.prisma.verifierSyncCursor.upsert({
      where: { verifierId },
      create: { verifierId, ...data },
      update: data,
    });
  }

  async listSyncState(): Promise<VerifierSyncCursorRecord[]> {
    const rows = await this.prisma.verifierSyncCursor.findMany();
    return rows.map(toCursorRecord);
  }

  /** Entry and re-timing in one transaction, or a reader could see the new entry at the old position. */
  async recordVerifierEntry(input: {
    verifierId: string;
    wasmHash: string;
    entry: {
      status: string;
      schemaVersion?: string;
      verifier?: unknown;
      recipeSource?: string;
      imageTrustLevel?: string;
      recipe?: unknown;
      verifiedSourceCodeUris?: unknown;
      resultsUrls?: unknown;
      processedAt?: string;
    };
    retrievedAt: string;
    now: string;
  }): Promise<void> {
    const row = {
      status: input.entry.status,
      schemaVersion: input.entry.schemaVersion ?? null,
      verifier: (input.entry.verifier ?? null) as never,
      recipeSource: input.entry.recipeSource ?? null,
      imageTrustLevel: input.entry.imageTrustLevel ?? null,
      recipe: (input.entry.recipe ?? null) as never,
      verifiedSourceCodeUris: (input.entry.verifiedSourceCodeUris ?? null) as never,
      resultsUrls: (input.entry.resultsUrls ?? null) as never,
      processedAt: input.entry.processedAt ? new Date(input.entry.processedAt) : null,
      retrievedAt: new Date(input.retrievedAt),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationResult.upsert({
        where: { verifierId_wasmHash: { verifierId: input.verifierId, wasmHash: input.wasmHash } },
        create: { verifierId: input.verifierId, wasmHash: input.wasmHash, ...row },
        update: row,
      });
      await reindex(tx, input.wasmHash, input.now);
    });
  }

  async withdrawVerifierEntry(input: { verifierId: string; wasmHash: string; now: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.verificationResult.deleteMany({
        where: { verifierId: input.verifierId, wasmHash: input.wasmHash },
      });
      if (deleted.count === 0) return;
      await reindex(tx, input.wasmHash, input.now);
    });
  }

  async listCachedEntriesForHash(wasmHash: string): Promise<VerifierResultCacheRecord[]> {
    const rows = await this.prisma.verificationResult.findMany({
      where: { wasmHash },
      orderBy: { verifierId: "asc" },
    });
    return rows.map(toCacheRecord);
  }

  async listCachedEntriesForHashes(wasmHashes: string[]): Promise<VerifierResultCacheRecord[]> {
    if (wasmHashes.length === 0) return [];
    const rows = await this.prisma.verificationResult.findMany({
      where: { wasmHash: { in: wasmHashes } },
      orderBy: [{ wasmHash: "asc" }, { verifierId: "asc" }],
    });
    return rows.map(toCacheRecord);
  }

  /** Keyset paging: an offset would drop records exactly when one is re-timed. */
  async listAggregationIndex(opts: {
    cursor?: AggregationCursor;
    order: SortOrder;
    limit: number;
  }): Promise<AggregationIndexRecord[]> {
    const rows = await this.prisma.aggregatedWasmIndex.findMany({
      ...(opts.cursor ? { where: keysetWhere(opts.cursor, opts.order) } : {}),
      orderBy: [{ aggregationUpdatedAt: opts.order }, { wasmHash: opts.order }],
      take: opts.limit,
    });
    return rows.map((row) => ({
      wasmHash: row.wasmHash,
      aggregationUpdatedAt: row.aggregationUpdatedAt.toISOString(),
    }));
  }

  async countIndexed(): Promise<number> {
    return this.prisma.aggregatedWasmIndex.count();
  }
}

/** The digest covers the whole entry set, so a withdrawal is as detectable as an edit. */
async function reindex(
  tx: Pick<PrismaClient, "verificationResult" | "aggregatedWasmIndex">,
  wasmHash: string,
  now: string,
): Promise<void> {
  const entries = await tx.verificationResult.findMany({
    where: { wasmHash },
    orderBy: { verifierId: "asc" },
  });
  const digest = digestOf(entries);
  const existing = await tx.aggregatedWasmIndex.findUnique({ where: { wasmHash } });

  if (entries.length === 0) {
    // Delete the row too, or the stream keeps delivering a hash with no entries.
    if (existing) await tx.aggregatedWasmIndex.delete({ where: { wasmHash } });
    return;
  }
  if (existing?.entriesDigest === digest) return;

  const data = { aggregationUpdatedAt: new Date(now), entriesDigest: digest };
  await tx.aggregatedWasmIndex.upsert({
    where: { wasmHash },
    create: { wasmHash, ...data },
    update: data,
  });
}

/** Every column a reader can see must have a slot here, or its change never reaches a synchronised consumer. */
function digestOf(entries: Array<{
  verifierId: string;
  status: string;
  processedAt: Date | null;
  schemaVersion: string | null;
  verifier: unknown;
  recipeSource: string | null;
  imageTrustLevel: string | null;
  recipe: unknown;
  verifiedSourceCodeUris: unknown;
  resultsUrls: unknown;
}>): string {
  const canonical = entries.map((entry) => [
    entry.verifierId,
    entry.status,
    entry.processedAt?.toISOString() ?? "",
    entry.schemaVersion ?? "",
    entry.recipeSource ?? "",
    entry.imageTrustLevel ?? "",
    stableJson(entry.verifier),
    stableJson(entry.recipe),
    stableJson(entry.verifiedSourceCodeUris),
    stableJson(entry.resultsUrls),
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function keysetWhere(cursor: AggregationCursor, order: SortOrder): object {
  const at = new Date(cursor.timestampMs);
  return order === "asc"
    ? {
        OR: [
          { aggregationUpdatedAt: { gt: at } },
          { aggregationUpdatedAt: at, wasmHash: { gt: cursor.wasmHash } },
        ],
      }
    : {
        OR: [
          { aggregationUpdatedAt: { lt: at } },
          { aggregationUpdatedAt: at, wasmHash: { lt: cursor.wasmHash } },
        ],
      };
}

function toCacheRecord(row: {
  verifierId: string;
  wasmHash: string;
  status: string;
  schemaVersion: string | null;
  verifier: unknown;
  recipeSource: string | null;
  imageTrustLevel: string | null;
  recipe: unknown;
  verifiedSourceCodeUris: unknown;
  resultsUrls: unknown;
  processedAt: Date | null;
  retrievedAt: Date;
}): VerifierResultCacheRecord {
  return {
    verifierId: row.verifierId,
    wasmHash: row.wasmHash,
    status: row.status,
    ...(row.schemaVersion !== null ? { schemaVersion: row.schemaVersion } : {}),
    ...(row.verifier !== null ? { verifier: row.verifier } : {}),
    ...(row.recipeSource !== null ? { recipeSource: row.recipeSource } : {}),
    ...(row.imageTrustLevel !== null ? { imageTrustLevel: row.imageTrustLevel } : {}),
    ...(row.recipe !== null ? { recipe: row.recipe } : {}),
    ...(row.verifiedSourceCodeUris !== null ? { verifiedSourceCodeUris: row.verifiedSourceCodeUris } : {}),
    ...(row.resultsUrls !== null ? { resultsUrls: row.resultsUrls } : {}),
    ...(row.processedAt !== null ? { processedAt: row.processedAt.toISOString() } : {}),
    retrievedAt: row.retrievedAt.toISOString(),
  };
}

function toCursorRecord(row: {
  verifierId: string;
  cursor: string | null;
  updatedAt: Date | null;
  lastError: string | null;
  lastErrorReason: string | null;
}): VerifierSyncCursorRecord {
  return {
    verifierId: row.verifierId,
    ...(row.cursor !== null ? { cursor: row.cursor } : {}),
    ...(row.updatedAt !== null ? { updatedAt: row.updatedAt.toISOString() } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
    ...(row.lastErrorReason !== null ? { lastErrorReason: row.lastErrorReason } : {}),
  };
}
