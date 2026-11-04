import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";
import { stillNeedsStagedSourceWhere } from "./staged-source-need.js";

@Injectable()
export class UploadJobReferencesRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /** Must throw on failure: an unrecorded reference is an upload the sweep cannot protect. */
  async recordReference(uploadId: string, jobId: string): Promise<void> {
    await this.prisma.uploadJobReference.create({ data: { uploadId, jobId } });
  }

  async findJobIdsForUpload(uploadId: string): Promise<string[]> {
    const rows = await this.prisma.uploadJobReference.findMany({
      where: { uploadId },
      select: { jobId: true },
    });
    return rows.map((row) => row.jobId);
  }

  async hasOutstandingObligation(
    uploadId: string,
    ceilingMs: number,
    now: Date,
    maxRetryAttempts: number,
  ): Promise<boolean> {
    const jobIds = await this.findJobIdsForUpload(uploadId);
    if (jobIds.length === 0) return false;
    const count = await this.prisma.job.count({
      where: { id: { in: jobIds }, ...stillNeedsStagedSourceWhere(ceilingMs, now, maxRetryAttempts) },
    });
    return count > 0;
  }
}
