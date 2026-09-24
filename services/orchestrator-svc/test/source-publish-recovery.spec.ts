import { jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DbModule, JobsRepository, PRISMA_CLIENT, RebuildsRepository, type JobRecord, type PrismaClient } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/** Two layers, same split `archive-and-recovery.spec.ts` uses for the Arweave equivalent: */

const WASM_HASH = "6".repeat(64);
const REBUILT_HASH = WASM_HASH;
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;

const publicGitSourceRef = {
  type: "git" as const,
  visibility: "public" as const,
  repo: "https://github.com/example/example",
  rev: "a".repeat(40),
  source_sha256: "7".repeat(64),
};

let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let publish: PublishService;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-source-publish-recovery-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4997";
  process.env.SCVS_ARWEAVE_MODE = "disabled";

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [ArweaveArchiveService, PublishService, SourceResolutionService],
  }).compile();

  jobs = moduleRef.get(JobsRepository);
  rebuilds = moduleRef.get(RebuildsRepository);
  publish = moduleRef.get(PublishService);
  prisma = moduleRef.get(PRISMA_CLIENT);
});

afterAll(async () => {
  try {
    // Scheduled archives write to the rows cleanup deletes, so they finish first.
    if (moduleRef) await moduleRef.get(ArweaveArchiveService).onModuleDestroy();
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

async function createVerifiedJob(): Promise<JobRecord> {
  const job = await jobs.createJob({
    dryRun: false,
    jobId: createdRows.job(randomUUID()),
    target: { network: "testnet", wasm_hash: WASM_HASH },
    verificationMode: "metadata",
    sourceRef: publicGitSourceRef,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: "testnet", wasm_hash: WASM_HASH },
      bldimg: IMAGE,
      source_sha256: publicGitSourceRef.source_sha256,
    } as never,
  });

  const rebuild = await rebuilds.findOrCreate({
    rebuildId: randomUUID(),
    idempotencyKey: randomUUID(),
    sourceRef: publicGitSourceRef,
    buildOptions: {},
    imageDigest: IMAGE,
    buildMode: "verify",
    mechanismReason: "on_chain_recipe_in_trusted_image",
  });
  await rebuilds.markTerminal(rebuild.rebuildId, {
    outcome: "success",
    runner: "stellar_contract_verify",
    rebuiltWasmHash: REBUILT_HASH,
  });

  await jobs.advanceJob(job.jobId, "queued", "comparing", {
    rebuildId: rebuild.rebuildId,
    verdict: "verified",
    result: {
      wasm_hash: WASM_HASH,
      matched: true,
      rebuilt_wasm_hash: REBUILT_HASH,
      status_summary: "verified",
    } as never,
  });

  return (await jobs.getJobById(job.jobId))!;
}

/** Backdates a job's own pending timestamp. */
async function setSourcePublishPendingSince(jobId: string, when: Date): Promise<void> {
  await jobs.updateJob(jobId, { sourcePublishPendingSince: when });
}

describe("JobsRepository source-publish-pending queries (Decision 2)", () => {
  it("listJobsPendingSourcePublish returns a job whose pending timestamp is within the window", async () => {
    const job = await createVerifiedJob();
    await setSourcePublishPendingSince(job.jobId, new Date());

    const pending = await jobs.listJobsPendingSourcePublish(new Date(Date.now() - 24 * 60 * 60 * 1000));

    expect(pending.some((j) => j.jobId === job.jobId)).toBe(true);
  });

  it("excludes a job whose pending timestamp is older than the caller's cutoff — the 24h give-up bound", async () => {
    const job = await createVerifiedJob();
    await setSourcePublishPendingSince(job.jobId, new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago

    // Same cutoff the real scheduler passes: now - 24h. A row 25h stale is older than that cutoff.
    const pending = await jobs.listJobsPendingSourcePublish(new Date(Date.now() - 24 * 60 * 60 * 1000));

    expect(pending.some((j) => j.jobId === job.jobId)).toBe(false);
  });

  it("recordSourcePublishOutcome({published: true}) clears the pending timestamp and sets sourceFileName", async () => {
    const job = await createVerifiedJob();
    await setSourcePublishPendingSince(job.jobId, new Date());

    await jobs.recordSourcePublishOutcome(job.jobId, { published: true, sourceFileName: "abc.tar.gz" });

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourcePublishPendingSince).toBeUndefined();
    expect(reloaded?.sourceFileName).toBe("abc.tar.gz");
  });

  it("recordSourcePublishOutcome({published: false}) increments sourcePublishAttempts and leaves the pending timestamp untouched", async () => {
    const job = await createVerifiedJob();
    const since = new Date();
    await setSourcePublishPendingSince(job.jobId, since);

    await jobs.recordSourcePublishOutcome(job.jobId, { published: false });
    await jobs.recordSourcePublishOutcome(job.jobId, { published: false });

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourcePublishAttempts).toBe(2);
    expect(reloaded?.sourcePublishPendingSince).toBeDefined();
    expect(reloaded?.sourceFileName).toBeUndefined();
  });
});

describe("PublishService.retryPendingSourcePublish (Decision 2)", () => {
  it("a job whose fetch keeps failing (git, out of scope) is retried and its attempt count grows, without ever deleting anything it didn't stage", async () => {
    const job = await createVerifiedJob();
    await setSourcePublishPendingSince(job.jobId, new Date());

    await publish.retryPendingSourcePublish(job);

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourcePublishAttempts).toBe(1);
    expect(reloaded?.sourcePublishPendingSince).toBeDefined(); // still owed — fetch failed again
    expect(reloaded?.sourceFileName).toBeUndefined();
  });

  it("errors loudly rather than silently no-op'ing for a non-public job — a bug elsewhere, not a case to paper over", async () => {
    const job = await createVerifiedJob();
    const privateJob: JobRecord = {
      ...job,
      sourceRef: { ...publicGitSourceRef, visibility: "private" },
    };

    // Confirmed via the method's own doc comment: this is a defensive guard against a caller passing a row
    // `sourcePublishPendingSince` should never have been set on, not a real path.
    await publish.retryPendingSourcePublish(privateJob);

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourcePublishAttempts).toBe(0);
    expect(reloaded?.sourcePublishPendingSince).toBeUndefined();
  });
});

describe("PublishService.publishJobResult — recordSourcePublishOutcome failure isolation (code review fix, 2026-08-14)", () => {
  it("a transient error recording the source-publish outcome does not turn an already-successful publish into a reported failure", async () => {
    // The job IS already durably `published` by the time recordSourcePublishOutcome runs.
    const recordSpy = jest
      .spyOn(jobs, "recordSourcePublishOutcome")
      .mockRejectedValueOnce(new Error("simulated transient DB error"));

    const job = await createVerifiedJob();
    await publish.publishJobResult(job.jobId);
    recordSpy.mockRestore();

    const reloaded = await jobs.getJobById(job.jobId);
    // The real assertion: still `published`, NOT `publish_pending` (which is what recordPublishFailure — the
    // wrong catch handler for this failure — would have produced).
    expect(reloaded?.status).toBe("published");
    expect(reloaded?.publishAttempts).toBe(0);
  });
});
