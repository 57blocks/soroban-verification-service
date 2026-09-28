import { randomBytes, randomUUID } from "node:crypto";
import {
  JobsRepository,
  RebuildsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { terminalJobStatuses } from "@scvs/core";

const IMAGE = `docker.io/example/img@sha256:${"c".repeat(64)}`;

let client: PrismaClient;
let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
const createdRows = new CreatedRows();

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  jobs = new JobsRepository(client);
  rebuilds = new RebuildsRepository(client);
});

afterAll(async () => {
  await createdRows.cleanup(client);
  await client.$disconnect();
});

const sourceRefFor = (sourceSha256: string) => ({
  type: "source_uri" as const,
  visibility: "public" as const,
  source_uri: "https://example.test/completed-at.tar.gz",
  source_sha256: sourceSha256,
});

async function seedQueuedJob(): Promise<string> {
  const jobId = createdRows.job(randomUUID());
  const sourceSha256 = randomBytes(32).toString("hex");
  await jobs.createJob({
    dryRun: false,
    jobId,
    target: { network: "testnet", wasm_hash: randomBytes(32).toString("hex") },
    verificationMode: "submitted",
    imageDigest: IMAGE,
    sourceRef: sourceRefFor(sourceSha256),
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      bldimg: IMAGE,
      source_sha256: sourceSha256,
      source_uri: "https://example.test/completed-at.tar.gz",
    } as never,
  });
  return jobId;
}

const read = async (jobId: string) => {
  const job = await jobs.getJobById(jobId);
  if (!job) throw new Error(`job ${jobId} vanished`);
  return job;
};

describe("a job records when it settled", () => {
  it("has none while it is in flight", async () => {
    const jobId = await seedQueuedJob();
    expect((await read(jobId)).completedAt).toBeUndefined();

    for (const [from, to] of [
      ["queued", "preparing"],
      ["preparing", "building"],
      ["building", "comparing"],
      ["comparing", "publishing"],
    ] as const) {
      expect(await jobs.advanceJob(jobId, from, to)).toBe(true);
      expect((await read(jobId)).completedAt).toBeUndefined();
    }
  });

  it.each(terminalJobStatuses)("records one on the transition to %s", async (terminal) => {
    const jobId = await seedQueuedJob();
    const before = Date.now();
    expect(
      await jobs.advanceJob(jobId, "queued", terminal, {
        ...(terminal === "failed" ? { failureReason: "internal_error" as const } : {}),
        ...(terminal === "published" || terminal === "evaluated"
          ? { verdict: "verified" as const }
          : {}),
      }),
    ).toBe(true);

    const job = await read(jobId);
    expect(job.status).toBe(terminal);
    expect(job.completedAt).toBeDefined();
    const completedMs = Date.parse(job.completedAt as string);
    expect(completedMs).toBeGreaterThanOrEqual(before - 1000);
    expect(completedMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("records one for a dry run, which publishes nothing to read it off", async () => {
    const jobId = await seedQueuedJob();
    expect(
      await jobs.advanceJob(jobId, "queued", "evaluated", { verdict: "mismatched" }),
    ).toBe(true);

    const job = await read(jobId);
    expect(job.result?.verified_at).toBeUndefined();
    expect(job.completedAt).toBeDefined();
  });

  it("writes neither the status nor the instant when the conditional write loses", async () => {
    const jobId = await seedQueuedJob();
    expect(await jobs.advanceJob(jobId, "queued", "preparing")).toBe(true);

    expect(await jobs.advanceJob(jobId, "queued", "published", { verdict: "verified" })).toBe(false);

    const job = await read(jobId);
    expect(job.status).toBe("preparing");
    expect(job.completedAt).toBeUndefined();
  });
});

describe("nothing but a status transition moves it", () => {
  const settle = async (): Promise<{ jobId: string; completedAt: string; updatedAt: string }> => {
    const jobId = await seedQueuedJob();
    expect(await jobs.advanceJob(jobId, "queued", "published", { verdict: "verified" })).toBe(true);
    const job = await read(jobId);
    return {
      jobId,
      completedAt: job.completedAt as string,
      updatedAt: job.updatedAt,
    };
  };

  it.each([
    [
      "a failed report archive",
      (jobId: string) => jobs.recordArchiveOutcome(jobId, { archived: false }),
    ],
    [
      "a failed source publish",
      (jobId: string) => jobs.recordSourcePublishOutcome(jobId, { published: false }),
    ],
    [
      "a failed source archive",
      (jobId: string) => jobs.recordSourceArchiveOutcome(jobId, { archived: false }),
    ],
    [
      "a build-log key recorded after the fact",
      (jobId: string) => jobs.recordBuildLogKeyForRebuild(jobId, "build-logs/x/build.log"),
    ],
  ] as const)("%s leaves it untouched", async (_label, write) => {
    const { jobId, completedAt, updatedAt } = await settle();

    await write(jobId);

    const after = await read(jobId);
    expect(after.completedAt).toBe(completedAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(updatedAt));
  });

  it("a successful archive advances the publication clock and still not this one", async () => {
    const { jobId, completedAt } = await settle();

    await jobs.recordArchiveOutcome(jobId, {
      archived: true,
      txId: `tx-${randomBytes(6).toString("hex")}`,
      statusLink: { state: "complete", advancePublished: true },
    });

    const after = await read(jobId);
    expect(after.archivedTxId).toBeDefined();
    expect(after.publishedUpdatedAt).toBeDefined();
    expect(after.completedAt).toBe(completedAt);
  });
});

describe("a job that leaves a terminal status has no completion until it settles again", () => {
  it("Rule D's re-queue clears it, and the next outcome records a later one", async () => {
    const jobId = await seedQueuedJob();
    expect(
      await jobs.advanceJob(jobId, "queued", "failed", { failureReason: "internal_error" }),
    ).toBe(true);
    const firstCompletion = (await read(jobId)).completedAt;
    expect(firstCompletion).toBeDefined();

    expect(
      await jobs.requeueRetryableFailures(3, new Date(Date.now() - 60 * 60_000), [jobId]),
    ).toContain(jobId);

    const requeued = await read(jobId);
    expect(requeued.status).toBe("queued");
    expect(requeued.completedAt).toBeUndefined();

    expect(await jobs.advanceJob(jobId, "queued", "published", { verdict: "verified" })).toBe(true);
    const resettled = await read(jobId);
    expect(resettled.completedAt).toBeDefined();
    expect(Date.parse(resettled.completedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(firstCompletion as string),
    );
  });

  it("a job re-opened by a revived shared rebuild loses it too", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const rebuildId = createdRows.rebuild(randomUUID());
    await rebuilds.findOrCreate({
      rebuildId,
      idempotencyKey: `completed-at-${randomBytes(8).toString("hex")}`,
      imageDigest: IMAGE,
      sourceRef: sourceRefFor(sourceSha256),
      buildOptions: { bldopt: [], bldarg: [] },
      buildMode: "verify",
      mechanismReason: "on_chain_recipe_in_trusted_image",
    });

    const jobId = await seedQueuedJob();
    await jobs.updateJob(jobId, { rebuildId });
    expect(
      await jobs.advanceJob(jobId, "queued", "failed", {
        failureReason: "build_failed",
        error: "cli_failure",
      }),
    ).toBe(true);
    expect((await read(jobId)).completedAt).toBeDefined();

    expect(await jobs.reopenJobsFailedByRebuild(rebuildId, "cli_failure")).toContain(jobId);

    const reopened = await read(jobId);
    expect(reopened.status).toBe("building");
    expect(reopened.completedAt).toBeUndefined();
  });

  it("releasing a stranded publication leaves it unset — publish_pending is not settled", async () => {
    const jobId = await seedQueuedJob();
    expect(await jobs.advanceJob(jobId, "queued", "publishing", { verdict: "verified" })).toBe(true);
    expect((await read(jobId)).completedAt).toBeUndefined();

    expect(await jobs.releaseStalePublishing(new Date(Date.now() + 60_000), [jobId])).toEqual([
      jobId,
    ]);

    const released = await read(jobId);
    expect(released.status).toBe("publish_pending");
    expect(released.completedAt).toBeUndefined();
  });
});
