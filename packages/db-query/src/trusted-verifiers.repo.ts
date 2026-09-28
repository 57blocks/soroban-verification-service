import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import type { TrustedVerifierModel as PrismaTrustedVerifier } from "../generated/prisma/models.js";

export type TrustedVerifierRecord = {
  verifierId: string;
  manifestUrl: string;
  resultsRoot: string;
  displayName?: string;
  trustTier?: string;
  bulkLoadUrl?: string;
  status: string;
  addedAt: string;
};

@Injectable()
export class TrustedVerifiersRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /** Optional fields are written `?? null` so a field the seeded document drops is cleared, not left behind. */
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
