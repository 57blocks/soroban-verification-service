import type { PrismaClient } from "../client.js";
import { JobsRepository } from "../jobs.repo.js";

function reportSha256Of(resultSummary: unknown): string | undefined {
  if (typeof resultSummary !== "object" || resultSummary === null) return undefined;
  const value = (resultSummary as { artifact_sha256?: unknown }).artifact_sha256;
  return typeof value === "string" ? value : undefined;
}

export class CreatedRows {
  private readonly jobIds = new Set<string>();
  private readonly rebuildIds = new Set<string>();
  private readonly environmentIds = new Set<string>();
  private readonly uploadIds = new Set<string>();
  private readonly sourceArchiveUploadKeys = new Set<string>();
  private readonly reportArchiveUploadKeys = new Set<string>();

  job<T extends string | undefined>(jobId: T): T {
    if (jobId) this.jobIds.add(jobId);
    return jobId;
  }

  upload<T extends string | undefined>(uploadId: T): T {
    if (uploadId) this.uploadIds.add(uploadId);
    return uploadId;
  }

  rebuild<T extends string | undefined>(rebuildId: T): T {
    if (rebuildId) this.rebuildIds.add(rebuildId);
    return rebuildId;
  }

  environment<T extends string | undefined>(environmentId: T): T {
    if (environmentId) this.environmentIds.add(environmentId);
    return environmentId;
  }

  sourceArchiveUpload<T extends string | undefined>(sourceSha256: T): T {
    if (sourceSha256) this.sourceArchiveUploadKeys.add(sourceSha256);
    return sourceSha256;
  }

  reportArchiveUpload<T extends string | undefined>(reportSha256: T): T {
    if (reportSha256) this.reportArchiveUploadKeys.add(reportSha256);
    return reportSha256;
  }

  /** Jobs first: `Job.rebuildId` references `Rebuild.id` with no cascade. */
  async cleanup(prisma: PrismaClient): Promise<void> {
    if (
      this.jobIds.size === 0 &&
      this.rebuildIds.size === 0 &&
      this.environmentIds.size === 0 &&
      this.uploadIds.size === 0 &&
      this.sourceArchiveUploadKeys.size === 0 &&
      this.reportArchiveUploadKeys.size === 0
    ) {
      return;
    }

    if (this.jobIds.size > 0) {
      const rows = await prisma.job.findMany({
        where: { id: { in: [...this.jobIds] } },
        select: { rebuildId: true, resultSummary: true },
      });
      for (const { rebuildId, resultSummary } of rows) {
        this.rebuild(rebuildId ?? undefined);
        this.reportArchiveUpload(reportSha256Of(resultSummary));
      }
      await new JobsRepository(prisma).deleteJobs([...this.jobIds]);
      this.jobIds.clear();
    }

    if (this.rebuildIds.size > 0) {
      await prisma.rebuild.deleteMany({
        where: { id: { in: [...this.rebuildIds] }, jobs: { none: {} } },
      });
      this.rebuildIds.clear();
    }

    if (this.environmentIds.size > 0) {
      await prisma.environment.deleteMany({ where: { id: { in: [...this.environmentIds] } } });
      this.environmentIds.clear();
    }

    if (this.uploadIds.size > 0) {
      await prisma.uploadJobReference.deleteMany({ where: { uploadId: { in: [...this.uploadIds] } } });
      await prisma.upload.deleteMany({ where: { id: { in: [...this.uploadIds] } } });
      this.uploadIds.clear();
    }

    if (this.sourceArchiveUploadKeys.size > 0) {
      await prisma.sourceArchiveUpload.deleteMany({
        where: { sourceSha256: { in: [...this.sourceArchiveUploadKeys] } },
      });
      this.sourceArchiveUploadKeys.clear();
    }

    if (this.reportArchiveUploadKeys.size > 0) {
      await prisma.reportArchiveUpload.deleteMany({
        where: { reportSha256: { in: [...this.reportArchiveUploadKeys] } },
      });
      this.reportArchiveUploadKeys.clear();
    }
  }
}
