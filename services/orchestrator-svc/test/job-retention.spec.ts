import { randomBytes, randomUUID } from "node:crypto";
import {
  JobsRepository,
  RebuildsRepository,
  UploadJobReferencesRepository,
  UploadsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

let client: PrismaClient;
let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let uploads: UploadsRepository;
let uploadJobReferences: UploadJobReferencesRepository;
const createdRows = new CreatedRows();

const IMAGE = `docker.io/example/img@sha256:${"a".repeat(64)}`;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const cutoff = () => new Date(Date.now() + RETENTION_MS + 60_000);

const newPublishedHash = () => `a${randomBytes(31).toString("hex")}f`;

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  jobs = new JobsRepository(client);
  rebuilds = new RebuildsRepository(client);
  uploads = new UploadsRepository(client);
  uploadJobReferences = new UploadJobReferencesRepository(client);
});

afterAll(async () => {
  try {
    await createdRows.cleanup(client);
  } finally {
    await client.$disconnect();
  }
});

function sourceRefFor(sourceSha256: string) {
  return {
    type: "source_uri" as const,
    visibility: "public" as const,
    source_uri: "https://example.test/s.tar.gz",
    source_sha256: sourceSha256,
  };
}

async function createJob(opts: { rebuildId?: string } = {}): Promise<string> {
  const sourceSha256 = randomBytes(32).toString("hex");
  const jobId = createdRows.job(randomUUID());
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
      source_uri: "https://example.test/s.tar.gz",
    } as never,
  });
  if (opts.rebuildId) await jobs.advanceJob(jobId, "queued", "preparing", { rebuildId: opts.rebuildId });
  return jobId;
}

async function createFailedJob(): Promise<string> {
  const jobId = await createJob();
  await jobs.advanceJob(jobId, "queued", "failed", {
    failureReason: "internal_error",
    error: "fixture_never_published",
  });
  return jobId;
}

async function createPublishedJob(wasmHash: string, publishedUpdatedAt: Date): Promise<string> {
  const jobId = await createJob();
  await jobs.advanceJob(jobId, "queued", "published", { verdict: "verified", wasmHash, publishedUpdatedAt });
  return jobId;
}

describe("listPrunableJobs", () => {
  it("selects a job that never published and leaves a published one alone", async () => {
    const failed = await createFailedJob();
    const published = await createPublishedJob(newPublishedHash(), new Date("2026-01-01T00:00:00.000Z"));

    const candidates = await jobs.listPrunableJobs({ before: cutoff(), limit: 500 });
    const ids = candidates.map((row) => row.jobId);

    expect(ids).toContain(failed);
    expect(ids).not.toContain(published);
  });

  it("leaves a job carrying an unfinished obligation, however old", async () => {
    const owing = await createFailedJob();
    await client.job.update({ where: { id: owing }, data: { archivePendingSince: new Date(0) } });

    const ids = (await jobs.listPrunableJobs({ before: cutoff(), limit: 500 })).map(
      (row) => row.jobId,
    );

    expect(ids).not.toContain(owing);
  });

  it("respects its limit, so a first sweep of a long-retained database is bounded", async () => {
    await createFailedJob();
    await createFailedJob();

    expect(await jobs.listPrunableJobs({ before: cutoff(), limit: 1 })).toHaveLength(1);
  });
});

describe("pruneJobs", () => {
  it("takes the job's upload references with it — no foreign key cascades them", async () => {
    const jobId = await createFailedJob();
    const uploadId = createdRows.upload(randomUUID());
    await uploads.createUpload({ id: uploadId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await uploadJobReferences.recordReference(uploadId, jobId);

    await jobs.pruneJobs([jobId]);

    expect(await uploadJobReferences.findJobIdsForUpload(uploadId)).toEqual([]);
  });

  it("drops the rebuild only once its last job is gone (ADR-008 — a rebuild is shared)", async () => {
    const rebuildId = createdRows.rebuild(randomUUID());
    await rebuilds.findOrCreate({
      rebuildId,
      idempotencyKey: `retention-${randomBytes(8).toString("hex")}`,
      imageDigest: IMAGE,
      sourceRef: sourceRefFor(randomBytes(32).toString("hex")),
      buildOptions: { bldopt: [], bldarg: [] },
      buildMode: "verify",
      mechanismReason: "on_chain_recipe_in_trusted_image",
    });
    const first = await createJob({ rebuildId });
    const second = await createJob({ rebuildId });

    await jobs.pruneJobs([first]);
    expect(await client.rebuild.findUnique({ where: { id: rebuildId } })).not.toBeNull();

    await jobs.pruneJobs([second]);
    expect(await client.rebuild.findUnique({ where: { id: rebuildId } })).toBeNull();
  });
});

describe("published records are not the sweep's business", () => {
  it("★ a bulk-load consumer's incremental sync is unaffected by pruning unpublished jobs", async () => {
    const mine = [newPublishedHash(), newPublishedHash(), newPublishedHash()].sort();
    const published = await Promise.all(
      mine.map((wasmHash, index) =>
        createPublishedJob(wasmHash, new Date(`2026-02-0${index + 1}T00:00:00.000Z`)),
      ),
    );
    const failed = [await createFailedJob(), await createFailedJob()];

    const ourPage = (records: { wasmHash: string; publishedUpdatedAt: string }[]) =>
      records.filter((row) => mine.includes(row.wasmHash));
    const before = ourPage(await jobs.listPublished({ order: "asc", limit: 200 }));
    expect(before.map((row) => row.wasmHash)).toEqual(mine);
    const resumeFrom = {
      timestampMs: new Date(before[0].publishedUpdatedAt).getTime(),
      wasmHash: before[0].wasmHash,
    };

    const selectable = (await jobs.listPrunableJobs({ before: cutoff(), limit: 500 })).map((row) => row.jobId);
    expect(failed.every((jobId) => selectable.includes(jobId))).toBe(true);
    expect(published.some((jobId) => selectable.includes(jobId))).toBe(false);
    expect(await jobs.pruneJobs(failed)).toBe(failed.length);

    for (const jobId of failed) expect(await jobs.getJobById(jobId)).toBeUndefined();
    for (const jobId of published) expect(await jobs.getJobById(jobId)).toBeDefined();

    const resumed = ourPage(await jobs.listPublished({ order: "asc", limit: 200, cursor: resumeFrom }));
    expect(resumed.map((row) => row.wasmHash)).toEqual(mine.slice(1));
    expect(ourPage(await jobs.listPublished({ order: "asc", limit: 200 }))).toEqual(before);
  });

  it("keeps the configured period inside counsel's 30-90 day range", async () => {
    const { default: configuration } = await import("../src/config/configuration.js");
    const { jobRetentionMs } = configuration();

    expect(jobRetentionMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60_000);
    expect(jobRetentionMs).toBeLessThanOrEqual(90 * 24 * 60 * 60_000);
    expect(jobRetentionMs).toBe(RETENTION_MS);
  });
});
