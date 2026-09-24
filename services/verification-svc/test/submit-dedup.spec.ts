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

/** Backdates a job's `updated_at` past the dedup staleness window. */
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

// A suite removes what it created, and only what it created. The disconnect is in a `finally` so a failed
// cleanup leaves one red signal, not two.
afterAll(async () => {
  try {
    await app?.close();
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

/** Posts a submission and registers whatever job came back, so `afterAll` can remove it. */
async function submit(body: object): Promise<request.Response> {
  const res = await request(server).post("/api/verification/v1/verifications").send(body);
  createdRows.job(res.body?.job_id);
  return res;
}

/**
 * One submission's worth of matching pieces: the HTTP body, plus a helper to plant a prior job that shares this
 * submission's source/options while naming whatever target you pass.
 */
/**
 * The one `source_uri` every job this suite creates carries — seeded through the repository or created
 * server-side by a real `POST /api/verification/v1/verifications`.
 */
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

/** All five are gone. */
describe("POST /api/verification/v1/verifications job creation and target dedup", () => {
  it("gives two targets sharing one build recipe their own separate jobs", async () => {
    // Two targets are two questions about two sets of deployed bytes, so they must be two jobs.
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
    // And it is about the caller's contract, not the one that happened to share the recipe.
    expect(res.body.target).toMatchObject({ contract_id: fixture.target.contract_id });

    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.target.contract_id).toBe(fixture.target.contract_id);
    // Sharing is deferred to orchestrator-svc, which attaches both jobs to one `Rebuild` on its next tick — so
    // a fresh job starts with no rebuild and no borrowed result.
    expect(created?.rebuildId).toBeUndefined();
    expect(created?.result).toBeUndefined();
  });

  it("still reuses an in-flight job for the *same* target", async () => {
    // Target-level dedup survives — it answers "you already asked for this", which is a question about the
    // caller's own target rather than about the build recipe.
    const fixture = submission();
    const jobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(jobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "queued", job_id: jobId });
    expect(res.body.target).toMatchObject({ contract_id: fixture.target.contract_id });
  });

  it("never answers a submission with an internal JobStatus, whatever state the reused job is in", async () => {
    // Guards the whole contract rather than the one status that happened to break: `building` and `comparing`
    // are both non-terminal, so both reach the dedup branch.
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
    // `comparing` is non-terminal, `getActiveJobForTarget` returns the OLDEST match, and nothing aged a row
    // out.
    const fixture = submission();
    const wedgedJobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(wedgedJobId, "queued", "building");
    // Well past the 30min default, and independent of it — the point is "much older than any window".
    await backdateJob(wedgedJobId, 6 * 60 * 60_000);

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).not.toBe(wedgedJobId);

    // The wedged job is left exactly as it was — reviving it is the reaper's job, not submit's.
    expect((await jobsRepository.getJobById(wedgedJobId))?.status).toBe("building");
  });

  it("no longer blocks a submission because an earlier attempt at the same recipe failed", async () => {
    // A failure is a property of one attempt at one target; it must not veto a different submission.
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

    // And the failed row is left exactly as it was, rather than being re-driven for someone else.
    const untouched = await jobsRepository.getJobById(failedJobId);
    expect(untouched?.status).toBe("failed");
    expect(untouched?.failureReason).toBe("policy_rejected");
    expect(untouched?.target.contract_id).not.toBe(fixture.target.contract_id);
  });

  it("answers with a job rather than a stored verdict, even for a target verified before", async () => {
    // The short-circuit exists again.
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
    // No idempotency key remains at this layer, so two identical submissions are two jobs.
    const fixture = submission();

    const first = await submit(fixture.body);
    // The second must not be short-circuited by the *target* check either, so retire the first.
    await jobsRepository.advanceJob(first.body.job_id, "queued", "published", { progress: undefined });
    const second = await submit(fixture.body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.job_id).not.toBe(first.body.job_id);
  });

  // ── The dedup question is the whole submission, not just its target ─────────────────────

  it("does not answer an is_public:true submission with a private job still in flight", async () => {
    // The submitter's first attempt kept the source private; while that job was still running they resubmitted
    // asking for it to be published.
    const fixture = submission({ isPublic: true });
    const privateJobId = await fixture.createPriorJob(fixture.target, { visibility: "private" });
    await jobsRepository.advanceJob(privateJobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.status).toBe(202);
    expect(res.body.job_id).not.toBe(privateJobId);
    // The new job carries what was asked for, which is the whole point of creating it.
    const created = await jobsRepository.getJobById(res.body.job_id);
    expect(created?.sourceRef.visibility).toBe("public");
    // The private job is left exactly as it was — it answered its own submission correctly.
    expect((await jobsRepository.getJobById(privateJobId))?.sourceRef.visibility).toBe("private");
  });

  it("does not answer an is_public:false submission with a public job still in flight", async () => {
    // Reusing the public job would have that job's own `visibility: public` write `sources/<sha>` on its way to
    // terminal, against a declaration that said not to.
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
    // The bound on the two cases above: visibility joined the dedup question, it did not replace it.
    const fixture = submission({ isPublic: true });
    const jobId = await fixture.createPriorJob();
    await jobsRepository.advanceJob(jobId, "queued", "building");

    const res = await submit(fixture.body);

    expect(res.body).toMatchObject({ status: "queued", job_id: jobId });
  });

  it("does not answer a submission with an in-flight job built from a different source archive", async () => {
    // Two archives for one target are two questions, and the rebuild key orchestrator-svc computes comes from
    // `job.sourceRef`.
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
