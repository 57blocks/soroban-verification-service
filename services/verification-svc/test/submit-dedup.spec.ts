import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { submissionStatuses, type SourceReference } from "@scvs/core";
import { createTestApp } from "./bootstrap.js";

const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

async function backdateJob(jobId: string, ageMs: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE jobs SET updated_at = now() - ($1 || ' milliseconds')::interval WHERE id = $2::uuid`,
    String(ageMs),
    jobId,
  );
}

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

async function submit(body: object): Promise<request.Response> {
  const res = await request(server).post("/api/verification/v1/verifications").send(body);
  createdRows.job(res.body?.job_id);
  return res;
}

const FIXTURE_SOURCE_URI = "https://example.com/dedup-fixture.tar.gz";

function submission(options: { isPublic?: boolean } = {}) {
  const sourceSha256 = randomBytes(32).toString("hex");
  const sourceUri = FIXTURE_SOURCE_URI;
  const target = { network: "testnet" as const, contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}` };
  const manifest = {
    schema: "stellar-submitted-source-verification-manifest-v1",
    source_sha256: sourceSha256,
    source_uri: sourceUri,
    ...(options.isPublic === undefined ? {} : { is_public: options.isPublic }),
  };
  const declaredVisibility: "public" | "private" = options.isPublic ? "public" : "private";
  return {
    target,
    manifest,
    body: { target, manifest },
    async createPriorJob(
      priorTarget = target,
      overrides: { visibility?: "public" | "private"; sourceSha256?: string } = {},
    ): Promise<string> {
      const jobId = createdRows.job(randomUUID());
      const sourceRef: SourceReference = {
        type: "source_uri",
        visibility: overrides.visibility ?? declaredVisibility,
        source_uri: sourceUri,
        source_sha256: overrides.sourceSha256 ?? sourceSha256,
      };
      await jobsRepository.createJob({
        dryRun: false,
        jobId,
        target: priorTarget,
        verificationMode: "submitted",
        sourceRef,
        buildOptions: { bldopt: [], bldarg: [] },
        manifest: { ...manifest, target: priorTarget } as never,
      });
      return jobId;
    },
  };
}

describe("POST /api/verification/v1/verifications job creation and target dedup", () => {
  it("gives two targets sharing one build recipe their own separate jobs", async () => {
    const fixture = submission();
    const otherTarget = {
      network: "testnet" as const,
      contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}`,
    };
    const priorJobId = await fixture.createPriorJob(otherTarget);

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).not.toBe(priorJobId);
    expect(res.body.target).toMatchObject({ contract_id: fixture.target.contract_id });

    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.target.contract_id).toBe(fixture.target.contract_id);
    expect(created?.rebuildId).toBeUndefined();
    expect(created?.result).toBeUndefined();
  });

  it("still reuses an in-flight job for the *same* target", async () => {
    const fixture = submission();
    const jobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(jobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", job_id: jobId });
    expect(res.body.target).toMatchObject({ contract_id: fixture.target.contract_id });
  });

  it("never answers a submission with an internal JobStatus, whatever state the reused job is in", async () => {
    const permitted = new Set<string>(submissionStatuses);
    for (const jobStatus of [
      "queued",
      "preparing",
      "building",
      "comparing",
      "publishing",
      "publish_pending",
    ] as const) {
      const fixture = submission();
      const jobId = await fixture.createPriorJob();
      await jobsRepository.advanceJob(jobId, "queued", jobStatus);

      const res = await submit(fixture.body);

      expect(res.body.job_id).toBe(jobId);
      expect(permitted.has(res.body.status)).toBe(true);
    }
  });

  it("stops reusing an in-flight job once it has gone silent past the staleness window", async () => {
    const fixture = submission();
    const wedgedJobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(wedgedJobId, "queued", "building");
    await backdateJob(wedgedJobId, 6 * 60 * 60_000);

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).not.toBe(wedgedJobId);

    expect((await jobsRepository.getJobById(wedgedJobId))?.status).toBe("building");
  });

  it("no longer blocks a submission because an earlier attempt at the same recipe failed", async () => {
    const fixture = submission();
    const failedJobId = await fixture.createPriorJob({
      network: "testnet",
      contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}`,
    });
    await jobsRepository.advanceJob(failedJobId, "queued", "failed", {
      failureReason: "policy_rejected",
      error: "image_not_sdf_trusted",
      progress: undefined,
    });

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).not.toBe(failedJobId);

    const untouched = await jobsRepository.getJobById(failedJobId);
    expect(untouched?.status).toBe("failed");
    expect(untouched?.failureReason).toBe("policy_rejected");
    expect(untouched?.target.contract_id).not.toBe(fixture.target.contract_id);
  });

  it("answers with a job rather than a stored verdict, even for a target verified before", async () => {
    const fixture = submission();
    const publishedJobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(publishedJobId, "queued", "published", {
      verdict: "verified",
      result: {
        status_summary: "verified",
        wasm_hash: "a".repeat(64),
        rebuilt_wasm_hash: "a".repeat(64),
        matched: true,
        verified_at: new Date().toISOString(),
      },
      progress: undefined,
    });

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).not.toBe(publishedJobId);
    expect(res.body).not.toHaveProperty("result");
  });

  it("creates a distinct job per submission even for byte-identical repeat submissions", async () => {
    const fixture = submission();

    const first = await submit(fixture.body);
    await jobsRepository.advanceJob(first.body.job_id, "queued", "published", { progress: undefined });
    const second = await submit(fixture.body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.job_id).not.toBe(first.body.job_id);
  });

  it("does not answer an is_public:true submission with a private job still in flight", async () => {
    const fixture = submission({ isPublic: true });
    const privateJobId = await fixture.createPriorJob(fixture.target, { visibility: "private" });
    await jobsRepository.advanceJob(privateJobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.job_id).not.toBe(privateJobId);
    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.sourceRef.visibility).toBe("public");
    expect((await jobsRepository.getJobById(privateJobId))?.sourceRef.visibility).toBe("private");
  });

  it("does not answer an is_public:false submission with a public job still in flight", async () => {
    const fixture = submission({ isPublic: false });
    const publicJobId = await fixture.createPriorJob(fixture.target, { visibility: "public" });
    await jobsRepository.advanceJob(publicJobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.job_id).not.toBe(publicJobId);
    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.sourceRef.visibility).toBe("private");
  });

  it("still reuses an in-flight job when the visibility declaration agrees", async () => {
    const fixture = submission({ isPublic: true });
    const jobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(jobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.body).toMatchObject({ status: "queued", job_id: jobId });
  });

  it("does not answer a submission with an in-flight job built from a different source archive", async () => {
    const fixture = submission();
    const otherArchiveJobId = await fixture.createPriorJob(fixture.target, {
      sourceSha256: randomBytes(32).toString("hex"),
    });
    await jobsRepository.advanceJob(otherArchiveJobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.job_id).not.toBe(otherArchiveJobId);
    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.sourceRef.source_sha256).toBe(fixture.manifest.source_sha256);
  });
});
