import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { hashBuildLogToken, mintBuildLogToken } from "@scvs/core";
import { createTestApp } from "./bootstrap.js";

const prisma = createPrismaClient(readDbEnv());
const jobs = new JobsRepository(prisma);
const createdRows = new CreatedRows();

const LOG_KEY = "build-logs/fixture-rebuild/build.log";

/** Outside `build-logs/`, so the read is refused with a deterministic 502 before any S3 client exists. */
const UNREADABLE_KEY = "staging/uploads/not-a-build-log.txt";

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

async function createJobWithToken(
  opts: { logKey?: string | null; expiresAt?: Date } = {},
): Promise<{ jobId: string; token: string }> {
  const token = mintBuildLogToken();
  const jobId = createdRows.job(randomUUID());
  const sourceSha256 = randomBytes(32).toString("hex");
  await jobs.createJob({
    dryRun: false,
    jobId,
    buildLogTokenHash: hashBuildLogToken(token),
    target: { network: "testnet", wasm_hash: randomBytes(32).toString("hex") },
    verificationMode: "submitted",
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: "https://example.test/s.tar.gz",
      source_sha256: sourceSha256,
    } as never,
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      bldimg: `docker.io/example/img@sha256:${"a".repeat(64)}`,
      source_sha256: sourceSha256,
      source_uri: "https://example.test/s.tar.gz",
    } as never,
  });
  if (opts.logKey !== null) {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        buildLogObjectKey: opts.logKey ?? LOG_KEY,
        ...(opts.expiresAt ? { buildLogExpiresAt: opts.expiresAt } : {}),
      },
    });
  }
  return { jobId, token };
}

const getLog = (jobId: string, token?: string) => {
  const req = request(server).get(`/api/verification/v1/verifications/${jobId}/log`);
  return token ? req.set("X-Build-Log-Token", token) : req;
};

describe("raw build-log access (BL-1)", () => {
  it("refuses a request carrying no token, before it says whether the job exists", async () => {
    const { jobId } = await createJobWithToken();

    const real = await getLog(jobId);
    const invented = await getLog(randomUUID());

    expect(real.status).toBe(401);
    expect(real.body.error).toBe("build_log_token_required");
    expect(invented.status).toBe(401);
    expect(invented.body.error).toBe(real.body.error);
  });

  it("★ answers a wrong token exactly as it answers a job that does not exist", async () => {
    const { jobId } = await createJobWithToken();
    const someoneElses = mintBuildLogToken();

    const wrongToken = await getLog(jobId, someoneElses);
    const noSuchJob = await getLog(randomUUID(), someoneElses);

    expect(wrongToken.status).toBe(404);
    expect(noSuchJob.status).toBe(404);
    expect(wrongToken.body.error).toBe("not_found");
    expect(wrongToken.body.error).toBe(noSuchJob.body.error);
  });

  it("refuses a malformed token without treating it as a comparison", async () => {
    const { jobId } = await createJobWithToken();

    for (const malformed of ["x", "!".repeat(43), "a".repeat(4096)]) {
      expect((await getLog(jobId, malformed)).status).toBe(404);
    }
  });

  it("a job created before tokens existed has no token, so nothing unlocks its log", async () => {
    const { jobId } = await createJobWithToken();
    await prisma.job.update({ where: { id: jobId }, data: { buildLogTokenHash: null } });

    expect((await getLog(jobId, mintBuildLogToken())).status).toBe(404);
    expect((await getLog(jobId)).status).toBe(401);
  });

  it("★ the right token gets past authorisation — not 401, not 404, not 410", async () => {
    const { jobId, token } = await createJobWithToken({ logKey: UNREADABLE_KEY });

    const res = await getLog(jobId, token);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("build_log_unavailable");
  });

  it("answers 404 with the job's status when the job produced no log at all", async () => {
    const { jobId, token } = await createJobWithToken({ logKey: null });

    const res = await getLog(jobId, token);

    expect(res.status).toBe(404);
    expect(res.body.job_status).toBeDefined();
  });
});

describe("raw build-log expiry (BL-2)", () => {
  it("★ enforces expiry on read, before the sweep has deleted anything", async () => {
    const { jobId, token } = await createJobWithToken({ expiresAt: new Date(Date.now() - 1000) });

    const res = await getLog(jobId, token);

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("build_log_expired");
    expect(res.body.expired_at).toBeDefined();
  });

  it("lets a log whose expiry has not arrived through the gate", async () => {
    const { jobId, token } = await createJobWithToken({
      logKey: UNREADABLE_KEY,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await getLog(jobId, token)).status).toBe(502);
  });

  it("an expired log answers the same to a wrong token as to a right one — 404 wins", async () => {
    const { jobId } = await createJobWithToken({ expiresAt: new Date(Date.now() - 1000) });

    expect((await getLog(jobId, mintBuildLogToken())).status).toBe(404);
  });
});

describe("early deletion by the token holder (BL-3)", () => {
  const deleteLog = (jobId: string, token?: string) => {
    const req = request(server).delete(`/api/verification/v1/verifications/${jobId}/log`);
    return token ? req.set("X-Build-Log-Token", token) : req;
  };

  it("needs the same token the read does", async () => {
    const { jobId } = await createJobWithToken();

    expect((await deleteLog(jobId)).status).toBe(401);
    expect((await deleteLog(jobId, mintBuildLogToken())).status).toBe(404);
  });

  it("★ makes the log unreadable immediately, and is idempotent", async () => {
    const { jobId, token } = await createJobWithToken();

    expect((await deleteLog(jobId, token)).status).toBe(204);
    expect((await getLog(jobId, token)).status).toBe(410);
    expect((await deleteLog(jobId, token)).status).toBe(204);
  });

  it("deleting a job that never had a log succeeds rather than 404ing", async () => {
    const { jobId, token } = await createJobWithToken({ logKey: null });

    expect((await deleteLog(jobId, token)).status).toBe(204);
  });
});

describe("the minimized diagnostic layer (BL-6)", () => {
  const CAPTURED_OUTPUT = /excerpt|stdout|stderr|log_text|build_log_token/i;

  it("★ the job-status body says whether a log exists without carrying any of it", async () => {
    const { jobId } = await createJobWithToken({ expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(server).get(`/api/verification/v1/verifications/${jobId}`);

    expect(res.status).toBe(200);
    expect(res.body.build_log).toEqual({
      state: "available",
      requires_token: true,
      expires_at: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toMatch(CAPTURED_OUTPUT);
  });

  it("reports an expired log as expired, and a job that never built as none", async () => {
    const expired = await createJobWithToken({ expiresAt: new Date(Date.now() - 1000) });
    const never = await createJobWithToken({ logKey: null });

    const expiredBody = (await request(server).get(`/api/verification/v1/verifications/${expired.jobId}`)).body;
    const neverBody = (await request(server).get(`/api/verification/v1/verifications/${never.jobId}`)).body;

    expect(expiredBody.build_log).toEqual({ state: "expired", requires_token: false });
    expect(neverBody.build_log).toEqual({ state: "none", requires_token: false });
  });

  it("★ the token never appears on the job-status surface a shared link reaches", async () => {
    const { jobId, token } = await createJobWithToken();

    const body = JSON.stringify(
      (await request(server).get(`/api/verification/v1/verifications/${jobId}`)).body,
    );

    expect(body).not.toContain(token);
    expect(body).not.toContain(hashBuildLogToken(token));
  });
});
