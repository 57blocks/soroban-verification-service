import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createPrismaClient, JobsRepository, UploadJobReferencesRepository, UploadsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

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
        : key === "maxJobRetryAttempts"
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
    await seedJob(uploadId, "public");

    const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
    await service.deleteStagedUpload(finishingJobSourceRef);

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });

  it("deletes the upload when no OTHER job still owes it a publish — the single-job case is unchanged", async () => {
    const uploadId = await seedUpload();
    const { sourceRef } = await seedJob(uploadId, "private");

    const service = new SourceResolutionService(configService(), uploads, uploadJobReferences);
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
      // Raw SQL: Prisma's @updatedAt overwrites `updated_at` on every repository write.
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
