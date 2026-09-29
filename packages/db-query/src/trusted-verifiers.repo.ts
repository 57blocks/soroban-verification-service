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

  /** Disables rather than deletes: a member leaves the list only by staying listed with its status. */
  async disableVerifiersNotIn(verifierIds: readonly string[]): Promise<string[]> {
    const rows = await this.prisma.trustedVerifier.findMany({
      where: { verifierId: { notIn: [...verifierIds] }, status: { not: "disabled" } },
      select: { verifierId: true },
    });
    const ids = rows.map((row) => row.verifierId);
    if (ids.length > 0) {
      await this.prisma.trustedVerifier.updateMany({ where: { verifierId: { in: ids } }, data: { status: "disabled" } });
    }
    return ids;
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
