import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import type { UploadModel as PrismaUpload } from "../generated/prisma/models.js";

export type UploadRecord = {
  id: string;
  expiresAt: string;
  received: boolean;
  path?: string;
  filename?: string;
  sizeBytes?: number;
  sourceSha256?: string;
  visibility: "public" | "private";
};

/** CRUD over the `uploads` table — pre-submission private-tarball staging, orthogonal to job state. */
@Injectable()
export class UploadsRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async createUpload(input: { id: string; expiresAt: string }): Promise<void> {
    await this.prisma.upload.create({ data: { id: input.id, expiresAt: new Date(input.expiresAt) } });
  }

  async markUploadReceived(
    id: string,
    updates: { path: string; filename: string; sizeBytes: number; sourceSha256: string },
  ): Promise<void> {
    await this.prisma.upload.update({
      where: { id },
      data: {
        received: true,
        path: updates.path,
        filename: updates.filename,
        sizeBytes: updates.sizeBytes,
        sourceSha256: updates.sourceSha256,
      },
    });
  }

  async getUpload(id: string): Promise<UploadRecord | undefined> {
    const row = await this.prisma.upload.findUnique({ where: { id } });
    return row ? rowToUpload(row) : undefined;
  }

  async listUploads(): Promise<UploadRecord[]> {
    const rows = await this.prisma.upload.findMany({ orderBy: { expiresAt: "asc" } });
    return rows.map(rowToUpload);
  }

  async deleteUpload(id: string): Promise<UploadRecord | undefined> {
    const existing = await this.getUpload(id);
    if (!existing) return undefined;
    await this.prisma.upload.delete({ where: { id } });
    return existing;
  }

  /**
   * Records the submitter's declared visibility once known (submit time, not upload time — the manifest that
   * carries `is_public` arrives after the upload itself in the two-step flow).
   */
  async setUploadVisibility(id: string, visibility: "public" | "private"): Promise<void> {
    await this.prisma.upload.update({ where: { id }, data: { visibility } });
  }
}

function rowToUpload(row: PrismaUpload): UploadRecord {
  return {
    id: row.id,
    expiresAt: row.expiresAt.toISOString(),
    received: row.received,
    visibility: row.visibility === "public" ? "public" : "private",
    ...(row.path ? { path: row.path } : {}),
    ...(row.filename ? { filename: row.filename } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: row.sizeBytes } : {}),
    ...(row.sourceSha256 ? { sourceSha256: row.sourceSha256 } : {}),
  };
}
