import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createPrismaClient, JobsRepository, UploadJobReferencesRepository, UploadsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/**
 * `SourceResolutionService` built directly over one Prisma client, same pattern `upload-cleanup.spec.ts` uses
 * for `UploadCleanupService`.
 */
const CEILING_MS = 4 * 60 * 60 * 1000;
const prisma = createPrismaClient(readDbEnv());
const jobs = new JobsRepository(prisma);
const uploads = new UploadsRepository(prisma);
const uploadJobReferences = new UploadJobReferencesRepository(prisma);
const createdRows = new CreatedRows();

function configService() {
  return {
    get: (key: string) =>
      key === "stagingSweepJobAgeCeilingMs"
        ? CEILING_MS
        : // The retry ceiling's third arm needs it; the production default travels with the
          // predicate's callers, and this stub mirrors it.
          key === "maxJobRetryAttempts"
          ? 3
          : undefined,
  } as unknown as ConstructorParameters<typeof SourceResolutionService>[0];
}

afterAll(async () => {
  try {
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

function contractId(): string {
  return `C${randomBytes(20).toString("hex").toUpperCase()}`;
}

/** A received (but never actually staged in S3 — this suite never reaches that branch) upload row. */
async function seedUpload(): Promise<string> {
  const uploadId = randomUUID();
  const sourceSha256 = createHash("sha256").update(randomBytes(64)).digest("hex");
  await uploads.createUpload({ id: uploadId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await uploads.markUploadReceived(uploadId, {
    path: `staging/uploads/${uploadId}/source.tar.gz`,
    filename: "source.tar.gz",
    sizeBytes: 64,
    sourceSha256,
  });
  createdRows.upload(uploadId);
  return uploadId;
}

/** Creates a job referencing `uploadId`, left `queued` (createJob's default — "still in flight"). */
async function seedJob(uploadId: string, visibility: "public" | "private") {
  const sourceSha256 = createHash("sha256").update(randomBytes(64)).digest("hex");
  const jobId = createdRows.job(randomUUID());
  const sourceRef = {
    type: "private_tarball" as const,
    visibility,
    source_sha256: sourceSha256,
    tarball_sha256: sourceSha256,
    upload_id: uploadId,
  };
  await jobs.createJob({
    jobId,
    target: { network: "testnet", contract_id: contractId() },
    verificationMode: "submitted",
    sourceRef,
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      source_sha256: sourceSha256,
      upload_id: uploadId,
    } as never,
    dryRun: false,
  });
  await uploadJobReferences.recordReference(uploadId, jobId);
  return { jobId, sourceRef };
}

describe("SourceResolutionService.deleteStagedUpload — sibling-job check (code review fix, 2026-08-14)", () => {
  it("does NOT delete the shared upload when a sibling job still owes it a source publish", async () => {
    const uploadId = await seedUpload();
    const { sourceRef: finishingJobSourceRef } = await seedJob(uploadId, "public");
    await seedJob(uploadId, "public"); // sibling: still queued, still owes a publish

    const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
    await service.deleteStagedUpload(finishingJobSourceRef);

    // The upload must survive: the sibling job (still queued) has not published its source yet.
    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });

  it("deletes the upload when no OTHER job still owes it a publish — the single-job case is unchanged", async () => {
    const uploadId = await seedUpload();
    const { sourceRef } = await seedJob(uploadId, "private"); // private: never owes anything

    const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
    // The DB row deletion this test asserts on happens BEFORE the S3 object delete (deleteStagedUpload's own
    // doc comment: "the only order where a crash between the two steps leaves a safe residue"), so it completes
    // regardless of `configService()`'s stub not providing a real `stagingStorage`.
    await service.deleteStagedUpload(sourceRef);

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  describe("a failed-but-retryable referencing job", () => {
    it("retains the upload while the failure is retryable, inside the window, with attempts left", async () => {
      const uploadId = await seedUpload();
      const { jobId, sourceRef } = await seedJob(uploadId, "private");
      await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "internal_error" });

      const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
      await service.deleteStagedUpload(sourceRef);

      expect(await uploads.getUpload(uploadId)).toBeDefined();
    });

    it("deletes once the retry budget is spent — nothing will revive the job", async () => {
      const uploadId = await seedUpload();
      const { jobId, sourceRef } = await seedJob(uploadId, "private");
      await jobs.advanceJob(jobId, "queued", "failed", {
        failureReason: "internal_error",
        retryAttempts: 3,
      });

      const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
      await service.deleteStagedUpload(sourceRef);

      expect(await uploads.getUpload(uploadId)).toBeUndefined();
    });

    it("deletes a non-retryable failure immediately — it is returned for correction, not retried", async () => {
      const uploadId = await seedUpload();
      const { jobId, sourceRef } = await seedJob(uploadId, "private");
      await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "policy_rejected" });

      const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
      await service.deleteStagedUpload(sourceRef);

      expect(await uploads.getUpload(uploadId)).toBeUndefined();
    });

    it("deletes a retryable failure that aged out of Rule D's eligibility window", async () => {
      const uploadId = await seedUpload();
      const { jobId, sourceRef } = await seedJob(uploadId, "private");
      await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "build_timeout" });
      // `updated_at` is Prisma's @updatedAt, reset by every repository write — raw SQL for the same reason
      // pipeline-e2e.spec.ts backdates rows.
      await prisma.$executeRawUnsafe(
        `UPDATE jobs SET updated_at = now() - interval '30 days' WHERE id = $1::uuid`,
        jobId,
      );

      const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
      await service.deleteStagedUpload(sourceRef);

      expect(await uploads.getUpload(uploadId)).toBeUndefined();
    });
  });
});
