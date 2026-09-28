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

  /** Compare-and-set: false when this caller's claim was reaped, and possibly re-claimed, meanwhile. */
  async markDone(reportSha256: string, txId: string): Promise<boolean> {
    const { count } = await this.prisma.reportArchiveUpload.updateMany({
      where: { reportSha256, status: "claimed" satisfies ReportArchiveUploadStatus },
      data: { status: "done" satisfies ReportArchiveUploadStatus, txId },
    });
    return count > 0;
  }

  async releaseClaim(reportSha256: string): Promise<void> {
    await this.prisma.reportArchiveUpload.deleteMany({
      where: { reportSha256, status: "claimed" satisfies ReportArchiveUploadStatus },
    });
  }

  /** `txId: null` is load-bearing: a done row with a txId records a paid upload and must never be deleted. */
  async discardCorruptDoneClaim(reportSha256: string): Promise<void> {
    await this.prisma.reportArchiveUpload.deleteMany({
      where: { reportSha256, status: "done" satisfies ReportArchiveUploadStatus, txId: null },
    });
  }
}

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
