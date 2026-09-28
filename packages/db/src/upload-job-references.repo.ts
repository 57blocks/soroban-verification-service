import { Inject, Injectable } from "@nestjs/common";
import {
  RETRY_ELIGIBILITY_WINDOW_MS,
  retryableFailureReasons,
  terminalJobStatuses,
} from "@scvs/core";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

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
    const cutoff = new Date(now.getTime() - ceilingMs);
    const retryWindowCutoff = new Date(now.getTime() - RETRY_ELIGIBILITY_WINDOW_MS);
    const count = await this.prisma.job.count({
      where: {
        id: { in: jobIds },
        createdAt: { gt: cutoff },
        OR: [
          { status: { notIn: [...terminalJobStatuses] }, sourceRef: { path: ["visibility"], equals: "public" } },
          { sourcePublishPendingSince: { not: null } },
          {
            status: "failed",
            failureReason: { in: [...retryableFailureReasons] },
            retryAttempts: { lt: maxRetryAttempts },
            updatedAt: { gte: retryWindowCutoff },
          },
        ],
      },
    });
    return count > 0;
  }
}
