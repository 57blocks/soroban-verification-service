import { jest } from "@jest/globals";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DEFAULT_MAX_JOB_RETRY_ATTEMPTS, type JobStatus } from "@scvs/core";
import {
  createPrismaClient,
  JobsRepository,
  RebuildsRepository,
  UploadJobReferencesRepository,
  UploadsRepository,
  readDbEnv,
  type JobRecord,
  type RebuildRecord,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";
import { StagedSourceReleaseService } from "../src/modules/source-resolution/staged-source-release.service.js";

const CEILING_MS = 4 * 60 * 60 * 1000;
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`;
const prisma = createPrismaClient(readDbEnv());
const jobs = new JobsRepository(prisma);
const rebuilds = new RebuildsRepository(prisma);
const uploads = new UploadsRepository(prisma);
const uploadJobReferences = new UploadJobReferencesRepository(prisma);
const createdRows = new CreatedRows();

const configService = {
  get: (key: string) =>
    key === "stagingSweepJobAgeCeilingMs"
      ? CEILING_MS
      : key === "maxJobRetryAttempts"
        ? DEFAULT_MAX_JOB_RETRY_ATTEMPTS
        : key === "stagingStorage"
          ? { bucket: "test-fixture-bucket", region: "us-east-1" }
          : undefined,
} as unknown as ConstructorParameters<typeof SourceResolutionService>[0];

function harness() {
  const sourceResolution = new SourceResolutionService(configService, uploads, uploadJobReferences);
  const deleted: string[] = [];
  jest.spyOn(sourceResolution, "deleteStagingObject").mockImplementation(async (key: string) => {
    deleted.push(key);
  });
  const release = new StagedSourceReleaseService(configService, jobs, rebuilds, sourceResolution);
  return { release, deleted };
}

afterAll(async () => {
  try {
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

const contractId = () => `C${randomBytes(20).toString("hex").toUpperCase()}`;
const freshSha = () => createHash("sha256").update(randomBytes(64)).digest("hex");

async function seedRebuild(status: "pending" | "done" = "done"): Promise<RebuildRecord> {
  const rebuild = await rebuilds.create({
    rebuildId: createdRows.rebuild(randomUUID()),
    idempotencyKey: randomUUID(),
    sourceRef: { type: "source_uri", visibility: "private", source_uri: "https://example.com/a.tar.gz", source_sha256: freshSha() },
    buildOptions: {},
    imageDigest: IMAGE,
    buildMode: "verify",
    mechanismReason: "on_chain_recipe_in_trusted_image",
  });
  if (status === "done") {
    await rebuilds.markTerminal(rebuild.rebuildId, { outcome: "success", runner: "stellar_contract_verify", rebuiltWasmHash: "a".repeat(64) });
  }
  return (await rebuilds.getById(rebuild.rebuildId))!;
}

async function seedJob(
  rebuildId: string,
  opts: { visibility: "public" | "private"; status: JobStatus; failureReason?: "internal_error" | "build_failed"; retryAttempts?: number; createdAt?: Date; sourcePublishPending?: boolean },
): Promise<JobRecord> {
  const sourceSha256 = freshSha();
  const jobId = createdRows.job(randomUUID());
  await jobs.createJob({
    jobId,
    target: { network: "testnet", contract_id: contractId() },
    verificationMode: "submitted",
    sourceRef: { type: "source_uri", visibility: opts.visibility, source_uri: "https://example.com/a.tar.gz", source_sha256: sourceSha256 },
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: { schema: "stellar-submitted-source-verification-manifest-v1", source_sha256: sourceSha256, source_uri: "https://example.com/a.tar.gz" } as never,
    dryRun: false,
  });
  await prisma.job.update({
    where: { id: jobId },
    data: {
      rebuildId,
      status: opts.status,
      ...(opts.failureReason ? { failureReason: opts.failureReason } : {}),
      ...(opts.retryAttempts !== undefined ? { retryAttempts: opts.retryAttempts } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.sourcePublishPending ? { sourcePublishPendingSince: new Date() } : {}),
    },
  });
  return (await jobs.getJobById(jobId))!;
}

const expectedKeys = (rebuildId: string) => [
  `staging/${rebuildId}/verify/fetched-source`,
  `staging/${rebuildId}/verify/canonical-source`,
  `staging/${rebuildId}/build/fetched-source`,
  `staging/${rebuildId}/build/canonical-source`,
];

describe("StagedSourceReleaseService.releaseRebuildSources", () => {
  it("deletes the fetched and canonical copies under both build modes once the last job is done, and records it", async () => {
    const rebuild = await seedRebuild();
    await seedJob(rebuild.rebuildId, { visibility: "private", status: "published" });
    const { release, deleted } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "job_terminal")).toBe("released");

    expect(deleted.sort()).toEqual(expectedKeys(rebuild.rebuildId).sort());
    expect((await rebuilds.getById(rebuild.rebuildId))!.stagedSourceReleasedAt).toBeDefined();
  });

  it("is idempotent: a released rebuild is not deleted from again", async () => {
    const rebuild = await seedRebuild();
    await seedJob(rebuild.rebuildId, { visibility: "private", status: "failed", failureReason: "build_failed" });
    const { release, deleted } = harness();

    await release.releaseRebuildSources(rebuild.rebuildId, "job_terminal");
    expect(await release.releaseRebuildSources(rebuild.rebuildId, "sweep")).toBe("already_released");

    expect(deleted).toHaveLength(4);
  });

  it("touches nothing while the rebuild itself is not finished", async () => {
    const rebuild = await seedRebuild("pending");
    await seedJob(rebuild.rebuildId, { visibility: "private", status: "failed", failureReason: "build_failed" });
    const { release, deleted } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "job_terminal")).toBe("not_done");

    expect(deleted).toEqual([]);
    expect((await rebuilds.getById(rebuild.rebuildId))!.stagedSourceReleasedAt).toBeUndefined();
  });

  it("keeps the copies while a public job attached to the rebuild is still in flight", async () => {
    const rebuild = await seedRebuild();
    await seedJob(rebuild.rebuildId, { visibility: "private", status: "published" });
    await seedJob(rebuild.rebuildId, { visibility: "public", status: "building" });
    const { release, deleted } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "job_terminal")).toBe("kept");

    expect(deleted).toEqual([]);
  });

  it("keeps the copies while a job attached to the rebuild still owes a source publish", async () => {
    const rebuild = await seedRebuild();
    await seedJob(rebuild.rebuildId, { visibility: "public", status: "published", sourcePublishPending: true });
    const { release, deleted } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "sweep")).toBe("kept");

    expect(deleted).toEqual([]);
  });

  it("keeps the copies while a failed job can still be retried, and releases once its retries are spent", async () => {
    const rebuild = await seedRebuild();
    const job = await seedJob(rebuild.rebuildId, { visibility: "private", status: "failed", failureReason: "internal_error", retryAttempts: 0 });
    const { release, deleted } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "job_terminal")).toBe("kept");
    expect(deleted).toEqual([]);

    await prisma.job.update({ where: { id: job.jobId }, data: { retryAttempts: DEFAULT_MAX_JOB_RETRY_ATTEMPTS } });
    expect(await release.releaseRebuildSources(rebuild.rebuildId, "sweep")).toBe("released");
    expect(deleted).toHaveLength(4);
  });

  it("does not let an in-flight public job older than the age ceiling hold the copies forever", async () => {
    const rebuild = await seedRebuild();
    await seedJob(rebuild.rebuildId, { visibility: "public", status: "building", createdAt: new Date(Date.now() - CEILING_MS - 60_000) });
    const { release } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "sweep")).toBe("released");
  });

  it("a private job in flight does not hold them: it read its source at dispatch and never publishes it", async () => {
    const rebuild = await seedRebuild();
    await seedJob(rebuild.rebuildId, { visibility: "private", status: "comparing" });
    const { release } = harness();

    expect(await release.releaseRebuildSources(rebuild.rebuildId, "job_terminal")).toBe("released");
  });
});

describe("StagedSourceReleaseService.releaseForTerminalJob", () => {
  it("releases the job's upload and its rebuild's copies in one call", async () => {
    const rebuild = await seedRebuild();
    const job = await seedJob(rebuild.rebuildId, { visibility: "private", status: "published" });
    const { release, deleted } = harness();

    await release.releaseForTerminalJob(job);

    expect(deleted).toHaveLength(4);
    expect((await rebuilds.getById(rebuild.rebuildId))!.stagedSourceReleasedAt).toBeDefined();
  });

  it("survives a delete failure: the job's terminal path must not throw, the sweep retries", async () => {
    const rebuild = await seedRebuild();
    const job = await seedJob(rebuild.rebuildId, { visibility: "private", status: "published" });
    const { release } = harness();
    const sourceResolution = (release as unknown as { sourceResolution: SourceResolutionService }).sourceResolution;
    jest.spyOn(sourceResolution, "deleteStagingObject").mockRejectedValue(new Error("AccessDenied"));

    await expect(release.releaseForTerminalJob(job)).resolves.toBeUndefined();

    expect((await rebuilds.getById(rebuild.rebuildId))!.stagedSourceReleasedAt).toBeUndefined();
  });

  it("does nothing beyond the upload for a job that never attached to a rebuild", async () => {
    const { release, deleted } = harness();

    await release.releaseForTerminalJob({
      jobId: randomUUID(),
      rebuildId: undefined,
      sourceRef: { type: "source_uri", visibility: "private", source_uri: "https://example.com/a.tar.gz", source_sha256: freshSha() },
    });

    expect(deleted).toEqual([]);
  });
});

describe("RebuildsRepository staged-source bookkeeping", () => {
  it("a re-dispatch clears the release mark, because the next attempt writes fresh copies", async () => {
    const rebuild = await seedRebuild();
    expect(await rebuilds.markStagedSourceReleased(rebuild.rebuildId)).toBe(true);

    await prisma.rebuild.update({ where: { id: rebuild.rebuildId }, data: { status: "pending" } });
    await rebuilds.markDispatched(rebuild.rebuildId, { batchJobId: "batch-1", buildMode: "verify" });

    expect((await rebuilds.getById(rebuild.rebuildId))!.stagedSourceReleasedAt).toBeUndefined();
  });

  it("resetting a cli_failure rebuild clears the release mark with the rest of its attempt", async () => {
    const rebuild = await seedRebuild();
    await prisma.rebuild.update({ where: { id: rebuild.rebuildId }, data: { outcome: "cli_failure" } });
    expect(await rebuilds.markStagedSourceReleased(rebuild.rebuildId)).toBe(true);

    expect(await rebuilds.requeueStaleCliFailure(rebuild.rebuildId, "verify")).toBe(true);

    expect((await rebuilds.getById(rebuild.rebuildId))!.stagedSourceReleasedAt).toBeUndefined();
  });

  it("only a finished rebuild can be marked released", async () => {
    const rebuild = await seedRebuild("pending");

    expect(await rebuilds.markStagedSourceReleased(rebuild.rebuildId)).toBe(false);
  });

  it("lists finished, unreleased rebuilds older than the cutoff, oldest first, and nothing else", async () => {
    const old = await seedRebuild();
    const released = await seedRebuild();
    const fresh = await seedRebuild();
    const pending = await seedRebuild("pending");
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await prisma.rebuild.update({ where: { id: old.rebuildId }, data: { updatedAt: longAgo } });
    await prisma.rebuild.update({ where: { id: released.rebuildId }, data: { updatedAt: longAgo, stagedSourceReleasedAt: new Date() } });
    await prisma.rebuild.update({ where: { id: pending.rebuildId }, data: { updatedAt: longAgo } });

    const listed = (await rebuilds.listStagedSourceReleaseCandidates({ doneBefore: new Date(Date.now() - 60 * 60_000), limit: 10_000 }))
      .map((r) => r.rebuildId);

    expect(listed).toContain(old.rebuildId);
    expect(listed).not.toContain(released.rebuildId);
    expect(listed).not.toContain(fresh.rebuildId);
    expect(listed).not.toContain(pending.rebuildId);
  });
});
