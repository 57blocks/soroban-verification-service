import { jest } from "@jest/globals";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createPrismaClient, JobsRepository, UploadJobReferencesRepository, UploadsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { UploadCleanupService } from "../src/common/upload-cleanup.js";

const prisma = createPrismaClient(readDbEnv());
const jobs = new JobsRepository(prisma);
const uploads = new UploadsRepository(prisma);
const uploadJobReferences = new UploadJobReferencesRepository(prisma);
const createdRows = new CreatedRows();

const CEILING_MS = 4 * 60 * 60 * 1000;
function configService(ceilingMs = CEILING_MS) {
  return { get: () => ceilingMs } as unknown as ConstructorParameters<typeof UploadCleanupService>[2];
}

let removeUploadFilesSpy: ReturnType<typeof jest.spyOn>;
beforeAll(() => {
  removeUploadFilesSpy = jest
    .spyOn(UploadCleanupService.prototype, "removeUploadFiles")
    .mockResolvedValue(undefined);
});

afterAll(async () => {
  removeUploadFilesSpy.mockRestore();
  try {
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

async function seedUpload(expiresInMs = -1000): Promise<string> {
  const uploadId = randomUUID();
  const sourceSha256 = createHash("sha256").update(randomBytes(64)).digest("hex");
  await uploads.createUpload({ id: uploadId, expiresAt: new Date(Date.now() + expiresInMs).toISOString() });
  await uploads.markUploadReceived(uploadId, {
    path: `staging/uploads/${uploadId}/source.tar.gz`,
    filename: "source.tar.gz",
    sizeBytes: 64,
    sourceSha256,
  });
  createdRows.upload(uploadId);
  return uploadId;
}

function contractId(): string {
  return `C${randomBytes(20).toString("hex").toUpperCase()}`;
}

async function seedJob(uploadId: string, visibility: "public" | "private"): Promise<string> {
  const sourceSha256 = createHash("sha256").update(randomBytes(64)).digest("hex");
  const jobId = createdRows.job(randomUUID());
  await jobs.createJob({
    jobId,
    target: { network: "testnet", contract_id: contractId() },
    verificationMode: "submitted",
    sourceRef: {
      type: "private_tarball",
      visibility,
      source_sha256: sourceSha256,
      tarball_sha256: sourceSha256,
      upload_id: uploadId,
    },
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      source_sha256: sourceSha256,
      upload_id: uploadId,
    } as never,
    dryRun: false,
  });
  await uploadJobReferences.recordReference(uploadId, jobId);
  return jobId;
}

async function markEvaluated(jobId: string): Promise<void> {
  await jobs.advanceJob(jobId, "queued", "evaluated", { verdict: "verified" });
}

async function markPublishedWithPendingSource(jobId: string): Promise<void> {
  await jobs.advanceJob(jobId, "queued", "published", {
    verdict: "verified",
    sourcePublishPendingSince: new Date(),
  });
  await jobs.recordSourcePublishOutcome(jobId, { published: false });
}

async function backdateJobCreatedAt(jobId: string, ageMs: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE jobs SET created_at = now() - ($1 || ' milliseconds')::interval WHERE id = $2::uuid`,
    String(ageMs),
    jobId,
  );
}

describe("UploadCleanupService sweep exemption (Decision 1)", () => {
  it("keeps an expired upload whose public job is still in flight (queued, never yet attempted a publish)", async () => {
    const uploadId = await seedUpload();
    await seedJob(uploadId, "public");
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });

  it("keeps an expired upload whose public job is terminal but its own publish attempt failed", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "public");
    await markPublishedWithPendingSource(jobId);
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });

  it("deletes an expired upload whose referencing job is private and done for", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "private");
    await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "policy_rejected" });
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  it("keeps an expired upload whose private job failed retryably — Rule D will revive it", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "private");
    await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "internal_error" });
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });

  it("deletes an expired upload whose public job already published its source", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "public");
    await jobs.advanceJob(jobId, "queued", "published", { verdict: "verified" });
    await jobs.recordSourcePublishOutcome(jobId, { published: true, sourceFileName: `${uploadId}.tar.gz` });
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  it("deletes an expired upload whose public job never attempted its own publish and reached a terminal status without one (evaluated/dry-run)", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "public");
    await markEvaluated(jobId);
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  it("deletes an expired upload whose public job is still in flight but past the age ceiling", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "public");
    await backdateJobCreatedAt(jobId, CEILING_MS + 60_000);
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  it("deletes an expired upload whose terminal job is still owed a retry but past the age ceiling", async () => {
    const uploadId = await seedUpload();
    const jobId = await seedJob(uploadId, "public");
    await markPublishedWithPendingSource(jobId);
    await backdateJobCreatedAt(jobId, CEILING_MS + 60_000);
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  it("deletes an expired upload no job references at all — unchanged from before this decision", async () => {
    const uploadId = await seedUpload();
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeUndefined();
  });

  it("never deletes an upload that has not expired yet, regardless of job state", async () => {
    const uploadId = await seedUpload(30 * 60 * 1000);
    const jobId = await seedJob(uploadId, "private");
    await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "internal_error" });
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });

  it("holds an upload with MULTIPLE referencing jobs as long as ANY one still owes a publish", async () => {
    const uploadId = await seedUpload();
    const jobFinished = await seedJob(uploadId, "public");
    await jobs.advanceJob(jobFinished, "queued", "published", { verdict: "verified" });
    await jobs.recordSourcePublishOutcome(jobFinished, { published: true, sourceFileName: `${uploadId}.tar.gz` });
    await seedJob(uploadId, "public");
    const service = new UploadCleanupService(uploads, uploadJobReferences, configService());

    await service.cleanupExpiredUploads();

    expect(await uploads.getUpload(uploadId)).toBeDefined();
  });
});
