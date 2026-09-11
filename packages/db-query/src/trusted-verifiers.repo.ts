import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import type { TrustedVerifierModel as PrismaTrustedVerifier } from "../generated/prisma/models.js";

export type TrustedVerifierRecord = {
  verifierId: string;
  manifestUrl: string;
  resultsRoot: string;
  /** The operator's name for this member. */
  displayName?: string;
  /** Free-form tier label from the document; absent when it carried none. Nothing here reads it. */
  trustTier?: string;
  /** Nullable at the column. */
  bulkLoadUrl?: string;
  /** `active` | `paused` | `disabled`, as a plain string. */
  status: string;
  addedAt: string;
};

/**
 * CRUD over the `trusted_verifiers` table, seeded from the document `SCVS_TRUSTED_VERIFIERS_SOURCE` names by
 * scripts/seed-tvl.ts.
 */
@Injectable()
export class TrustedVerifiersRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * Every optional field is written `?? null` on update, deliberately: the seeded document is the source of
   * truth and the table is its projection, so a field the document drops is cleared rather than left behind
   * (see scripts/seed-tvl.ts's header).
   */
  async upsertTrustedVerifier(input: {
    verifierId: string;
    manifestUrl: string;
    resultsRoot: string;
    displayName?: string;
    trustTier?: string;
    bulkLoadUrl?: string;
    status?: string;
  }): Promise<TrustedVerifierRecord> {
    const row = await this.prisma.trustedVerifier.upsert({
      where: { verifierId: input.verifierId },
      create: {
        verifierId: input.verifierId,
        manifestUrl: input.manifestUrl,
        resultsRoot: input.resultsRoot,
        displayName: input.displayName ?? null,
        trustTier: input.trustTier ?? null,
        bulkLoadUrl: input.bulkLoadUrl ?? null,
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      update: {
        manifestUrl: input.manifestUrl,
        resultsRoot: input.resultsRoot,
        displayName: input.displayName ?? null,
        trustTier: input.trustTier ?? null,
        bulkLoadUrl: input.bulkLoadUrl ?? null,
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return rowToTrustedVerifier(row);
  }

  /**
   * `activeOnly` is the aggregation callers' filter: `paused` and `disabled` are both "do not query this one
   * right now", and only a status-reporting caller wants them back.
   */
  async listTrustedVerifiers(opts?: { activeOnly?: boolean }): Promise<TrustedVerifierRecord[]> {
    const rows = await this.prisma.trustedVerifier.findMany({
      where: opts?.activeOnly ? { status: "active" } : undefined,
      orderBy: { addedAt: "asc" },
    });
    return rows.map(rowToTrustedVerifier);
  }

  async setTrustedVerifierStatus(verifierId: string, status: string): Promise<void> {
    await this.prisma.trustedVerifier.update({ where: { verifierId }, data: { status } });
  }
}

function rowToTrustedVerifier(row: PrismaTrustedVerifier): TrustedVerifierRecord {
  return {
    verifierId: row.verifierId,
    manifestUrl: row.manifestUrl,
    resultsRoot: row.resultsRoot,
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    ...(row.trustTier !== null ? { trustTier: row.trustTier } : {}),
    ...(row.bulkLoadUrl !== null ? { bulkLoadUrl: row.bulkLoadUrl } : {}),
    status: row.status,
    addedAt: row.addedAt.toISOString(),
  };
}
