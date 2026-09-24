import { jest } from "@jest/globals";
import type { Server } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  createPrismaClient,
  JobsRepository,
  UploadJobReferencesRepository,
  UploadsRepository,
  readDbEnv,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createTestApp } from "./bootstrap.js";

/**
 * Seeds `uploads` rows directly via the repository rather than going through `POST
 * /api/verification/v1/uploads/source`.
 */
const prisma = createPrismaClient(readDbEnv());
const uploadsRepository = new UploadsRepository(prisma);
const createdRows = new CreatedRows();

let app: NestExpressApplication;
let server: Server;
beforeAll(async () => {
  app = await createTestApp();
  server = app.getHttpServer();
});

afterAll(async () => {
  try {
    await app?.close();
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

/**
 * Mirrors what `uploads.service.ts`'s `receive()` writes for a real upload, minus the S3 PUT: a received row
 * with a real sha256 of some fixture bytes, expiring 30 minutes out by default.
 */
async function seedUpload(options: { expiresInMs?: number } = {}): Promise<{ uploadId: string; sourceSha256: string }> {
  const uploadId = randomUUID();
  const sourceSha256 = createHash("sha256").update(randomBytes(64)).digest("hex");
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 30 * 60 * 1000)).toISOString();
  await uploadsRepository.createUpload({ id: uploadId, expiresAt });
  await uploadsRepository.markUploadReceived(uploadId, {
    path: `staging/uploads/${uploadId}/source.tar.gz`,
    filename: "source.tar.gz",
    sizeBytes: 64,
    sourceSha256,
  });
  return { uploadId, sourceSha256 };
}

function target() {
  return { network: "testnet" as const, contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}` };
}

describe("POST /api/verification/v1/verifications upload cross-check (S27)", () => {
  it("rejects a manifest whose source_sha256 disagrees with the upload's own computed hash", async () => {
    const { uploadId } = await seedUpload();
    const claimedWrongHash = createHash("sha256").update(randomBytes(64)).digest("hex");

    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({
        target: target(),
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          source_sha256: claimedWrongHash,
          upload_id: uploadId,
        },
      });
    createdRows.job(res.body?.job_id);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_hash_mismatch");
    // And no job was created for the dishonest claim.
    expect(res.body.job_id).toBeUndefined();

    await uploadsRepository.deleteUpload(uploadId);
  });

  it("accepts a manifest whose source_sha256 matches the upload's own computed hash", async () => {
    const { uploadId, sourceSha256 } = await seedUpload();
    createdRows.upload(uploadId);

    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({
        target: target(),
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          source_sha256: sourceSha256,
          upload_id: uploadId,
        },
      });
    createdRows.job(res.body?.job_id);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");

    const jobsRepository = new JobsRepository(prisma);
    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.sourceRef.source_sha256).toBe(sourceSha256);

    const uploadJobReferences = new UploadJobReferencesRepository(prisma);
    const jobIds = await uploadJobReferences.findJobIdsForUpload(uploadId);
    expect(jobIds).toContain(res.body.job_id);
  });

  it("still returns the created job_id when recordReference fails (code review fix, 2026-08-14)", async () => {
    // The job row is a separate, already-committed write by the time recordReference runs.
    const { uploadId, sourceSha256 } = await seedUpload();
    createdRows.upload(uploadId);
    const uploadJobReferences = app.get(UploadJobReferencesRepository);
    const recordSpy = jest
      .spyOn(uploadJobReferences, "recordReference")
      .mockRejectedValueOnce(new Error("simulated transient DB error"));

    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({
        target: target(),
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          source_sha256: sourceSha256,
          upload_id: uploadId,
        },
      });
    recordSpy.mockRestore();
    createdRows.job(res.body?.job_id);

    // The real assertion: still 202/queued with a real job_id, NOT a 500 that swallows it.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).toBeDefined();

    const jobsRepository = new JobsRepository(prisma);
    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created).toBeDefined();
  });

  it("rejects an upload_id with no live upload row (never uploaded, or already expired/swept)", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({
        target: target(),
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          source_sha256: createHash("sha256").update(randomBytes(64)).digest("hex"),
          upload_id: "00000000-0000-0000-0000-000000000000",
        },
      });
    createdRows.job(res.body?.job_id);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("upload_not_found");
    expect(res.body.job_id).toBeUndefined();
  });

  it("rejects an upload_id whose upload has already expired", async () => {
    const { uploadId, sourceSha256 } = await seedUpload({ expiresInMs: -1000 });

    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({
        target: target(),
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          source_sha256: sourceSha256,
          upload_id: uploadId,
        },
      });
    createdRows.job(res.body?.job_id);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("upload_expired");
    expect(res.body.job_id).toBeUndefined();

    await uploadsRepository.deleteUpload(uploadId);
  });
});
