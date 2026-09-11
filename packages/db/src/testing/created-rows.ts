import type { PrismaClient } from "../client.js";
import { JobsRepository } from "../jobs.repo.js";

/** `jobs.result_summary`'s `artifact_sha256` — the key a published job's archive claim is filed under. */
function reportSha256Of(resultSummary: unknown): string | undefined {
  if (typeof resultSummary !== "object" || resultSummary === null) return undefined;
  const value = (resultSummary as { artifact_sha256?: unknown }).artifact_sha256;
  return typeof value === "string" ? value : undefined;
}

/** Rows one spec file created, so its `afterAll` can remove exactly those and nothing else. */
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

  /**
   * Registered by hand, like `environment` — an `Upload` has no column pointing at a job to read it back from
   * either.
   */
  upload<T extends string | undefined>(uploadId: T): T {
    if (uploadId) this.uploadIds.add(uploadId);
    return uploadId;
  }

  rebuild<T extends string | undefined>(rebuildId: T): T {
    if (rebuildId) this.rebuildIds.add(rebuildId);
    return rebuildId;
  }

  /** Registered by hand, unlike rebuilds. */
  environment<T extends string | undefined>(environmentId: T): T {
    if (environmentId) this.environmentIds.add(environmentId);
    return environmentId;
  }

  /**
   * Registered by hand, same reasoning as `environment` — keyed purely on content (`source_sha256`), so there
   * is no job column to read it back from.
   */
  sourceArchiveUpload<T extends string | undefined>(sourceSha256: T): T {
    if (sourceSha256) this.sourceArchiveUploadKeys.add(sourceSha256);
    return sourceSha256;
  }

  /** Registered by hand, same reasoning as `sourceArchiveUpload` — keyed purely on content (`report_sha256`). */
  reportArchiveUpload<T extends string | undefined>(reportSha256: T): T {
    if (reportSha256) this.reportArchiveUploadKeys.add(reportSha256);
    return reportSha256;
  }

  /** Jobs first: `Job.rebuildId` references `Rebuild.id` and the relation has no cascade. */
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
        // A published job's archive claim is keyed on its report's sha256, which only exists once
        // `publishJobResult` has written it onto the row — so it cannot be registered at creation time the
        // way a job id is. Read it back here, the same way `rebuildId` above is.
        this.reportArchiveUpload(reportSha256Of(resultSummary));
      }
      // No container here, so it is constructed directly, as `scripts/seed-tvl.ts` does.
      await new JobsRepository(prisma).deleteJobs([...this.jobIds]);
      this.jobIds.clear();
    }

    if (this.rebuildIds.size > 0) {
      await prisma.rebuild.deleteMany({
        where: { id: { in: [...this.rebuildIds] }, jobs: { none: {} } },
      });
      this.rebuildIds.clear();
    }

    // Last, and unconditionally by id: an `Environment` is referenced by nothing (a `Rebuild` keys on
    // `recipe_sha256`, not on the row), so there is no relation to wait for and no `none: {}` guard to apply.
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
