import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { ReportArchiveUploadModel as PrismaReportArchiveUpload } from "../generated/prisma/models.js";

export const reportArchiveUploadStatuses = ["claimed", "done"] as const;
export type ReportArchiveUploadStatus = (typeof reportArchiveUploadStatuses)[number];

export type ReportArchiveUploadRecord = {
  reportSha256: string;
  status: ReportArchiveUploadStatus;
  txId?: string;
  updatedAt: string;
};

@Injectable()
export class ReportArchiveUploadsRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * Find-or-create, safe against two callers (any process, any replica) discovering the same unclaimed
   * `report_sha256` at once — same pattern as `SourceArchiveUploadsRepository.findOrCreate`, re-keyed.
   */
  async findOrCreate(reportSha256: string): Promise<{ record: ReportArchiveUploadRecord; won: boolean }> {
    const existing = await this.getByReportSha256(reportSha256);
    if (existing) return { record: existing, won: false };
    try {
      const created = await this.prisma.reportArchiveUpload.create({ data: { reportSha256 } });
      return { record: rowToRecord(created), won: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.getByReportSha256(reportSha256);
        if (raced) return { record: raced, won: false };
        return this.findOrCreate(reportSha256);
      }
      throw error;
    }
  }

  async getByReportSha256(reportSha256: string): Promise<ReportArchiveUploadRecord | undefined> {
    const row = await this.prisma.reportArchiveUpload.findUnique({ where: { reportSha256 } });
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * `claimed -> done`, as a compare-and-set: returns `false` when this caller's claim is no longer the one on
   * the row. That happens when a losing caller reaped the claim as stale (`releaseClaim`) while this upload was
   * still running, and possibly re-claimed it — an unconditional `update` would then either throw P2025 or
   * silently overwrite the new claimant's row with this call's `txId`.
   */
  async markDone(reportSha256: string, txId: string): Promise<boolean> {
    const { count } = await this.prisma.reportArchiveUpload.updateMany({
      where: { reportSha256, status: "claimed" satisfies ReportArchiveUploadStatus },
      data: { status: "done" satisfies ReportArchiveUploadStatus, txId },
    });
    return count > 0;
  }

  /** Deletes the row so a later `findOrCreate` can re-claim it. */
  async releaseClaim(reportSha256: string): Promise<void> {
    await this.prisma.reportArchiveUpload.deleteMany({
      where: { reportSha256, status: "claimed" satisfies ReportArchiveUploadStatus },
    });
  }

  /**
   * Deletes a `done` row that carries no `txId` — a state `markDone` cannot produce, so it means the row was
   * corrupted out-of-band. The `txId: null` predicate is load-bearing: a `done` row WITH a `txId` is the record
   * that this content was already paid for, and deleting one reintroduces the double-spend this table prevents.
   */
  async discardCorruptDoneClaim(reportSha256: string): Promise<void> {
    await this.prisma.reportArchiveUpload.deleteMany({
      where: { reportSha256, status: "done" satisfies ReportArchiveUploadStatus, txId: null },
    });
  }
}

// Same contract as jobs.repo.ts's `rowToJob`: anything derived from a raw column rather than passed straight
// through is validated here, because the DB layer has no enum types of its own.
function rowToRecord(row: PrismaReportArchiveUpload): ReportArchiveUploadRecord {
  return {
    reportSha256: row.reportSha256,
    status: assertReportArchiveUploadStatus(row.status),
    ...(row.txId ? { txId: row.txId } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertReportArchiveUploadStatus(value: string): ReportArchiveUploadStatus {
  if ((reportArchiveUploadStatuses as readonly string[]).includes(value)) {
    return value as ReportArchiveUploadStatus;
  }
  throw new Error(`unrecognised report_archive_uploads.status: ${value}`);
}
