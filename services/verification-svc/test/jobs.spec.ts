import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createTestApp } from "./bootstrap.js";

const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

let app: NestExpressApplication;
let server: Server;
beforeAll(async () => {
  app = await createTestApp();
  server = app.getHttpServer();
});

// This fixture pins a fixed contract_id, so a leaked `queued` row would sit in the dedup path of every later
// submission naming that contract.
afterAll(async () => {
  try {
    await app?.close();
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

// Characterization test for GET /api/verification/v1/verifications/:job_id (verifications.controller.ts's
// getJob).

describe("GET /api/verification/v1/verifications/:job_id", () => {
  it("returns 404 for an unknown job id", async () => {
    const res = await request(server).get(`/api/verification/v1/verifications/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(res.body.status_code).toBe(404);
  });

  it("returns the job DTO for a freshly created queued job", async () => {
    const jobId = createdRows.job(randomUUID());
    await jobsRepository.createJob({
      dryRun: false,
      jobId,
      target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
      verificationMode: "submitted",
      sourceRef: { type: "source_uri", visibility: "public", source_uri: "https://example.com/fake.tar.gz", source_sha256: "0".repeat(64) } as any,
      buildOptions: {},
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
        bldimg: "docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43",
        source_sha256: "0".repeat(64),
        source_uri: "https://example.com/fake.tar.gz",
      } as any,
    });

    const res = await request(server).get(`/api/verification/v1/verifications/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      job_id: jobId,
      status: "queued",
      target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
    });
    expect(typeof res.body.created_at).toBe("string");
    expect(typeof res.body.updated_at).toBe("string");
    // In flight: the key is absent rather than null, matching the optional field on the client.
    expect(res.body).not.toHaveProperty("completed_at");
  });

  // `updated_at` keeps advancing after the verdict (archive and source-publish retries write settled rows), so
  // it cannot answer "when did this finish".
  it("reports completed_at once the job has settled, and does not move it afterwards", async () => {
    const jobId = createdRows.job(randomUUID());
    await jobsRepository.createJob({
      dryRun: false,
      jobId,
      target: { network: "testnet", wasm_hash: "3f".repeat(32) },
      verificationMode: "submitted",
      imageDigest: "sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43",
      sourceRef: { type: "source_uri", visibility: "public", source_uri: "https://example.com/fake.tar.gz", source_sha256: "1".repeat(64) } as any,
      buildOptions: {},
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        target: { network: "testnet", wasm_hash: "3f".repeat(32) },
        bldimg: "docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43",
        source_sha256: "1".repeat(64),
        source_uri: "https://example.com/fake.tar.gz",
      } as any,
    });
    await jobsRepository.advanceJob(jobId, "queued", "published", { verdict: "verified" });

    const settled = await request(server).get(`/api/verification/v1/verifications/${jobId}`);
    expect(settled.status).toBe(200);
    expect(settled.body.status).toBe("verified");
    const completedAt = settled.body.completed_at;
    expect(typeof completedAt).toBe("string");
    expect(completedAt).toBe((await jobsRepository.getJobById(jobId))?.completedAt);

    // An archive attempt fails on the settled row: `updated_at` moves, `completed_at` does not.
    await jobsRepository.recordArchiveOutcome(jobId, { archived: false });

    const again = await request(server).get(`/api/verification/v1/verifications/${jobId}`);
    expect(again.body.completed_at).toBe(completedAt);
    expect(Date.parse(again.body.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(settled.body.updated_at),
    );
  });
});
