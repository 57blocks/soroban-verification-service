import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "../generated/prisma/client.js";
import type { SourceArchiveUploadModel as PrismaSourceArchiveUpload } from "../generated/prisma/models.js";

export const sourceArchiveUploadStatuses = ["claimed", "done"] as const;
export type SourceArchiveUploadStatus = (typeof sourceArchiveUploadStatuses)[number];

export type SourceArchiveUploadRecord = {
  sourceSha256: string;
  status: SourceArchiveUploadStatus;
  txId?: string;
  updatedAt: string;
};

@Injectable()
export class SourceArchiveUploadsRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async findOrCreate(sourceSha256: string): Promise<{ record: SourceArchiveUploadRecord; won: boolean }> {
    const existing = await this.getBySourceSha256(sourceSha256);
    if (existing) return { record: existing, won: false };
    try {
      const created = await this.prisma.sourceArchiveUpload.create({ data: { sourceSha256 } });
      return { record: rowToRecord(created), won: true };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.getBySourceSha256(sourceSha256);
        if (raced) return { record: raced, won: false };
        return this.findOrCreate(sourceSha256);
      }
      throw error;
    }
  }

  async getBySourceSha256(sourceSha256: string): Promise<SourceArchiveUploadRecord | undefined> {
    const row = await this.prisma.sourceArchiveUpload.findUnique({ where: { sourceSha256 } });
    return row ? rowToRecord(row) : undefined;
  }

  /** Compare-and-set: false when this caller's claim was reaped, and possibly re-claimed, meanwhile. */
  async markDone(sourceSha256: string, txId: string): Promise<boolean> {
    const { count } = await this.prisma.sourceArchiveUpload.updateMany({
      where: { sourceSha256, status: "claimed" satisfies SourceArchiveUploadStatus },
      data: { status: "done" satisfies SourceArchiveUploadStatus, txId },
    });
    return count > 0;
  }

  async releaseClaim(sourceSha256: string): Promise<void> {
    await this.prisma.sourceArchiveUpload.deleteMany({
      where: { sourceSha256, status: "claimed" satisfies SourceArchiveUploadStatus },
    });
  }

  /** `txId: null` is load-bearing: a done row with a txId records a paid upload and must never be deleted. */
  async discardCorruptDoneClaim(sourceSha256: string): Promise<void> {
    await this.prisma.sourceArchiveUpload.deleteMany({
      where: { sourceSha256, status: "done" satisfies SourceArchiveUploadStatus, txId: null },
    });
  }
}

function rowToRecord(row: PrismaSourceArchiveUpload): SourceArchiveUploadRecord {
  return {
    sourceSha256: row.sourceSha256,
    status: assertSourceArchiveUploadStatus(row.status),
    ...(row.txId ? { txId: row.txId } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertSourceArchiveUploadStatus(value: string): SourceArchiveUploadStatus {
  if ((sourceArchiveUploadStatuses as readonly string[]).includes(value)) {
    return value as SourceArchiveUploadStatus;
  }
  throw new Error(`unrecognised source_archive_uploads.status: ${value}`);
}
