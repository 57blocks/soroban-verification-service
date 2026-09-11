import { jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DbModule, JobsRepository, PRISMA_CLIENT, RebuildsRepository, type JobRecord, type PrismaClient } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createResultStorage, readWasmStatus, sourceKeyFromFileName } from "@scvs/storage-layout";
import { toSourceCodeUri } from "@scvs/core";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { SourceArchiveRecoveryScheduler } from "../src/modules/scheduler/source-archive-recovery.scheduler.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/** Source-side sibling of `archive-and-recovery.spec.ts`. */

const WASM_HASH = "8".repeat(64);
const REBUILT_HASH = WASM_HASH;
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;

let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let publish: PublishService;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-mainnet-source-archive-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4996/public";
  process.env.SCVS_ARWEAVE_MODE = "dry-run";
  process.env.SCVS_ARWEAVE_GATEWAY_URL = "https://gateway.irys.xyz";
  // This suite exercises MSA-1's archive-eligible path, which now defaults off (design.md §8, MSA-5).
  process.env.SCVS_SOURCE_ARCHIVE_ENABLED = "true";

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [ArweaveArchiveService, PublishService, SourceArchiveRecoveryScheduler, SourceResolutionService],
  }).compile();

  jobs = moduleRef.get(JobsRepository);
  rebuilds = moduleRef.get(RebuildsRepository);
  publish = moduleRef.get(PublishService);
  prisma = moduleRef.get(PRISMA_CLIENT);
});

afterAll(async () => {
  try {
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

/** Polls until `condition` holds. */
async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sourceArchiveSettled(jobId: string): Promise<boolean> {
  const job = await jobs.getJobById(jobId);
  return job !== undefined && !job.sourceArchivePendingSince;
}

function resultStorage() {
  return createResultStorage({
    kind: "filesystem",
    root: resultRoot,
    publicRoot: "http://localhost:4996/public",
  });
}

/**
 * Writes `sources/{sha}{ext}` directly, bypassing the real staged-upload fetch — the fixture only needs the
 * bytes to exist at the key `attemptSourcePublish` would have written them to.
 */
async function stageDurableSource(sourceFileName: string): Promise<void> {
  await resultStorage().writeBytes(sourceKeyFromFileName(sourceFileName), new TextEncoder().encode("fixture bytes"), "application/octet-stream");
}

/**
 * Stubs the private `attemptSourcePublish` to report success without a real S3/network fetch — the source is
 * already staged via `stageDurableSource`, so "durable" is simply true. Defaults to the suite-wide `publish`;
 * pass a differently-configured instance (e.g. one built with `SCVS_SOURCE_ARCHIVE_ENABLED` unset) to stub that
 * one instead.
 */
function stubSourceAlreadyDurable(targetPublish: PublishService = publish): () => void {
  const internals = targetPublish as unknown as {
    attemptSourcePublish: (...args: never[]) => Promise<boolean>;
  };
  const real = internals.attemptSourcePublish;
  internals.attemptSourcePublish = async () => true;
  return () => {
    internals.attemptSourcePublish = real;
  };
}

/**
 * A fresh, per-test content-address so no test's durable `sources/` write is visible to another test's own
 * first (meant-to-fail) `attemptSourcePublish` call.
 */
function freshSource(): { sourceSha256: string; sourceFileName: string; uploadId: string } {
  const sourceSha256 = randomUUID().replace(/-/g, "").padEnd(64, "0");
  return { sourceSha256, sourceFileName: `${sourceSha256}.tar.gz`, uploadId: randomUUID() };
}

/** Defaults to the suite-wide `jobs`/`rebuilds`; pass a differently-configured pair to use those instead. */
async function createJob(
  opts: {
    network: "mainnet" | "testnet";
    visibility?: "public" | "private";
    sourceSha256: string;
    uploadId: string;
  },
  targetJobs: JobsRepository = jobs,
  targetRebuilds: RebuildsRepository = rebuilds,
): Promise<JobRecord> {
  const sourceRef = {
    type: "private_tarball" as const,
    visibility: opts.visibility ?? ("public" as const),
    upload_id: opts.uploadId,
    tarball_sha256: opts.sourceSha256,
    source_sha256: opts.sourceSha256,
  };

  const job = await targetJobs.createJob({
    dryRun: false,
    jobId: createdRows.job(randomUUID()),
    target: { network: opts.network, wasm_hash: WASM_HASH },
    verificationMode: "metadata",
    sourceRef,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: opts.network, wasm_hash: WASM_HASH },
      bldimg: IMAGE,
      source_sha256: opts.sourceSha256,
    } as never,
  });

  const rebuild = await targetRebuilds.findOrCreate({
    rebuildId: randomUUID(),
    idempotencyKey: randomUUID(),
    sourceRef,
    buildOptions: {},
    imageDigest: IMAGE,
    buildMode: "verify",
    mechanismReason: "on_chain_recipe_in_trusted_image",
  });
  await targetRebuilds.markTerminal(rebuild.rebuildId, {
    outcome: "success",
    runner: "stellar_contract_verify",
    rebuiltWasmHash: REBUILT_HASH,
  });

  await targetJobs.advanceJob(job.jobId, "queued", "comparing", {
    rebuildId: rebuild.rebuildId,
    verdict: "verified",
    result: {
      wasm_hash: WASM_HASH,
      matched: true,
      rebuilt_wasm_hash: REBUILT_HASH,
      status_summary: "verified",
    } as never,
  });

  return (await targetJobs.getJobById(job.jobId))!;
}

/**
 * `retryPendingSourcePublish`'s own precondition (its doc comment): `job.result.artifact_url` is only ever set
 * by a REAL `writePublication` run. Defaults to the suite-wide `jobs`/`publish`; pass a differently-configured
 * trio to exercise a job created against another module (e.g. `SCVS_SOURCE_ARCHIVE_ENABLED` unset).
 */
async function createPublishedJobPendingSourceArchive(
  opts: {
    network: "mainnet" | "testnet";
    visibility?: "public" | "private";
    sourceSha256: string;
    uploadId: string;
  },
  targetJobs: JobsRepository = jobs,
  targetRebuilds: RebuildsRepository = rebuilds,
  targetPublish: PublishService = publish,
): Promise<JobRecord> {
  const job = await createJob(opts, targetJobs, targetRebuilds);
  await targetPublish.publishJobResult(job.jobId);
  const publishedJob = (await targetJobs.getJobById(job.jobId))!;
  expect(publishedJob.status).toBe("published");
  expect(publishedJob.result?.artifact_url).toBeDefined();
  if (opts.visibility !== "private") {
    expect(publishedJob.sourcePublishPendingSince).toBeDefined(); // the source fetch above failed for real
  }
  return publishedJob;
}

describe("JobsRepository.recordSourcePublishOutcome — atomic sourceArchivePendingSince write (code review fix, 2026-08-26)", () => {
  it("writes sourceArchivePendingSince in the SAME call as published:true, when the caller passes it", async () => {
    const { sourceSha256, sourceFileName, uploadId } = freshSource();
    const job = await createJob({ network: "mainnet", sourceSha256, uploadId });

    await jobs.recordSourcePublishOutcome(job.jobId, {
      published: true,
      sourceFileName,
      sourceArchivePendingSince: new Date(),
    });

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourceFileName).toBe(sourceFileName);
    expect(reloaded?.sourceArchivePendingSince).toBeDefined();
  });

  it("omits sourceArchivePendingSince when the caller does not pass it — testnet/private jobs never set it", async () => {
    const { sourceSha256, sourceFileName, uploadId } = freshSource();
    const job = await createJob({ network: "testnet", sourceSha256, uploadId });

    await jobs.recordSourcePublishOutcome(job.jobId, { published: true, sourceFileName });

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourceFileName).toBe(sourceFileName);
    expect(reloaded?.sourceArchivePendingSince).toBeUndefined();
  });
});

describe("PublishService.retryPendingSourcePublish — mainnet archive eligibility (mainnet-source-archive design.md MSA-3)", () => {
  it("a mainnet+public job whose delayed source-publish retry succeeds becomes archive-eligible and the upload settles", async () => {
    const { sourceSha256, sourceFileName, uploadId } = freshSource();
    const job = await createPublishedJobPendingSourceArchive({ network: "mainnet", sourceSha256, uploadId });
    await stageDurableSource(sourceFileName);
    const unstub = stubSourceAlreadyDurable();

    try {
      await publish.retryPendingSourcePublish(job);
    } finally {
      unstub();
    }

    const afterRetry = await jobs.getJobById(job.jobId);
    expect(afterRetry?.sourceFileName).toBe(sourceFileName);
    // Set by the SAME recordSourcePublishOutcome call that cleared sourcePublishPendingSince — confirms the
    // eligibility check that ran before that call actually reached it.
    expect(afterRetry?.sourceArchivePendingSince).toBeDefined();

    await waitUntil(() => sourceArchiveSettled(job.jobId), "the mainnet source archive to settle");
    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.sourceArchivedTxId).toMatch(/^dryrun-/);

    const status = await readWasmStatus(resultStorage(), WASM_HASH);
    const uris = (status?.source_code_verifications[0]?.verified_source_code_uris ?? []).map(toSourceCodeUri);
    expect(uris.some((uri) => uri.location === "arweave" && uri.url.startsWith("https://gateway.irys.xyz/"))).toBe(
      true,
    );
    // No per-entry sha256 on the Arweave copy: the entry's own source_sha256 already anchors it.
    expect(status?.source_code_verifications[0]?.source_sha256).toBe(sourceSha256);
  });

  it("a testnet+public job's delayed retry never becomes archive-eligible", async () => {
    const { sourceSha256, sourceFileName, uploadId } = freshSource();
    const job = await createPublishedJobPendingSourceArchive({ network: "testnet", sourceSha256, uploadId });
    await stageDurableSource(sourceFileName);
    const unstub = stubSourceAlreadyDurable();

    try {
      await publish.retryPendingSourcePublish(job);
    } finally {
      unstub();
    }

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourceFileName).toBe(sourceFileName);
    expect(reloaded?.sourceArchivePendingSince).toBeUndefined();
    expect(reloaded?.sourceArchivedTxId).toBeUndefined();
  });

  it("a mainnet+private job's delayed retry never becomes archive-eligible", async () => {
    const { sourceSha256, uploadId } = freshSource();
    const job = await createPublishedJobPendingSourceArchive({
      network: "mainnet",
      visibility: "private",
      sourceSha256,
      uploadId,
    });
    const unstub = stubSourceAlreadyDurable();

    try {
      await publish.retryPendingSourcePublish(job);
    } finally {
      unstub();
    }

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourceArchivePendingSince).toBeUndefined();
  });

  it("regression: a transient recordSourcePublishOutcome failure leaves BOTH sourcePublishPendingSince and sourceArchivePendingSince untouched, so the next scan retries the whole attempt", async () => {
    const { sourceSha256, sourceFileName, uploadId } = freshSource();
    const job = await createPublishedJobPendingSourceArchive({ network: "mainnet", sourceSha256, uploadId });
    await stageDurableSource(sourceFileName);
    const unstub = stubSourceAlreadyDurable();

    const recordSpy = jest.spyOn(jobs, "recordSourcePublishOutcome").mockRejectedValueOnce(new Error("simulated transient DB error"));

    try {
      await expect(publish.retryPendingSourcePublish(job)).rejects.toThrow("simulated transient DB error");
    } finally {
      recordSpy.mockRestore();
      unstub();
    }

    // With one atomic call, a failure here leaves the row exactly as the first publish attempt left it —
    // nothing lost, nothing half-written.
    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.sourcePublishPendingSince).toBeDefined();
    expect(reloaded?.sourceFileName).toBeUndefined();
    expect(reloaded?.sourceArchivePendingSince).toBeUndefined();
  });
});

describe("PublishService.retryPendingSourcePublish — SCVS_SOURCE_ARCHIVE_ENABLED defaults off (design.md §8, MSA-5)", () => {
  // configuration() snapshots process.env once at ConfigModule.forRoot time, so the suite-wide moduleRef
  // (built with SCVS_SOURCE_ARCHIVE_ENABLED=true above) would never observe a later env mutation — this
  // test builds its own module instead.
  it("a mainnet+public job never becomes archive-eligible when SCVS_SOURCE_ARCHIVE_ENABLED is unset", async () => {
    const previous = process.env.SCVS_SOURCE_ARCHIVE_ENABLED;
    delete process.env.SCVS_SOURCE_ARCHIVE_ENABLED;

    let disabledModuleRef: TestingModule | undefined;
    try {
      disabledModuleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
          DbModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
          }),
        ],
        providers: [ArweaveArchiveService, PublishService, SourceArchiveRecoveryScheduler, SourceResolutionService],
      }).compile();
      const disabledJobs = disabledModuleRef.get(JobsRepository);
      const disabledRebuilds = disabledModuleRef.get(RebuildsRepository);
      const disabledPublish = disabledModuleRef.get(PublishService);

      const { sourceSha256, sourceFileName, uploadId } = freshSource();
      const publishedJob = await createPublishedJobPendingSourceArchive(
        { network: "mainnet", sourceSha256, uploadId },
        disabledJobs,
        disabledRebuilds,
        disabledPublish,
      );
      await stageDurableSource(sourceFileName);
      const unstub = stubSourceAlreadyDurable(disabledPublish);

      try {
        await disabledPublish.retryPendingSourcePublish(publishedJob);
      } finally {
        unstub();
      }

      const reloaded = await disabledJobs.getJobById(publishedJob.jobId);
      expect(reloaded?.sourceFileName).toBe(sourceFileName);
      expect(reloaded?.sourceArchivePendingSince).toBeUndefined();
      expect(reloaded?.sourceArchivedTxId).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.SCVS_SOURCE_ARCHIVE_ENABLED;
      else process.env.SCVS_SOURCE_ARCHIVE_ENABLED = previous;
      if (disabledModuleRef) await disabledModuleRef.close();
    }
  });
});

describe("PublishService.completeArchiveObligationsForAdoptedJob", () => {
  /**
   * Marks the obligation only — SourcePublishRecoveryScheduler/SourceArchiveRecoveryScheduler do the actual
   * work, exactly as they already do for a first-attempt `writePublication` failure.
   */
  function jobArgs(opts: {
    network: "mainnet" | "testnet";
    visibility?: "public" | "private";
    sourceSha256: string;
    uploadId: string;
    wasmHash: string;
  }) {
    const sourceRef = {
      type: "private_tarball" as const,
      visibility: opts.visibility ?? ("public" as const),
      upload_id: opts.uploadId,
      tarball_sha256: opts.sourceSha256,
      source_sha256: opts.sourceSha256,
    };
    return {
      dryRun: false,
      jobId: createdRows.job(randomUUID()),
      target: { network: opts.network, wasm_hash: opts.wasmHash },
      verificationMode: "metadata" as const,
      sourceRef,
      buildOptions: {},
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        target: { network: opts.network, wasm_hash: opts.wasmHash },
        bldimg: IMAGE,
        source_sha256: opts.sourceSha256,
      } as never,
    };
  }

  /** A published job carrying a real `result.artifact_url`, standing in for the donor. */
  async function createDonor(opts: {
    network: "mainnet" | "testnet";
    visibility?: "public" | "private";
    sourceSha256: string;
    uploadId: string;
    wasmHash: string;
  }): Promise<JobRecord> {
    const job = await jobs.createJob(jobArgs(opts));
    const rebuild = await rebuilds.findOrCreate({
      rebuildId: randomUUID(),
      idempotencyKey: randomUUID(),
      sourceRef: jobArgs(opts).sourceRef,
      buildOptions: {},
      imageDigest: IMAGE,
      buildMode: "verify",
      mechanismReason: "on_chain_recipe_in_trusted_image",
    });
    await rebuilds.markTerminal(rebuild.rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: opts.wasmHash,
    });
    await jobs.advanceJob(job.jobId, "queued", "comparing", {
      rebuildId: rebuild.rebuildId,
      verdict: "verified",
      result: {
        wasm_hash: opts.wasmHash,
        matched: true,
        rebuilt_wasm_hash: opts.wasmHash,
        status_summary: "verified",
      } as never,
    });
    await publish.publishJobResult(job.jobId);
    const donor = (await jobs.getJobById(job.jobId))!;
    expect(donor.status).toBe("published");
    expect(donor.result?.artifact_url).toBeDefined();
    return donor;
  }

  /**
   * The adopting job's own row, as `adoptPublishedVerdict` would leave it just before calling
   * `completeArchiveObligationsForAdoptedJob`: `comparing`, never itself published.
   */
  async function createAdopter(opts: {
    network: "mainnet" | "testnet";
    visibility?: "public" | "private";
    sourceSha256: string;
    uploadId: string;
    wasmHash: string;
  }): Promise<JobRecord> {
    const job = await jobs.createJob(jobArgs(opts));
    await jobs.advanceJob(job.jobId, "queued", "comparing", {});
    return (await jobs.getJobById(job.jobId))!;
  }

  it("marks a public adopter's own sourcePublishPendingSince, regardless of the donor's visibility", async () => {
    const wasmHash = randomUUID().replace(/-/g, "").padEnd(64, "1");
    const { sourceSha256, uploadId: uploadA } = freshSource();
    const donor = await createDonor({ network: "testnet", visibility: "private", sourceSha256, uploadId: uploadA, wasmHash });

    const { uploadId: uploadB } = freshSource();
    const adopter = await createAdopter({ network: "testnet", visibility: "public", sourceSha256, uploadId: uploadB, wasmHash });

    await publish.completeArchiveObligationsForAdoptedJob(adopter, donor);

    // B's own public declaration earns the obligation the private donor never could have — the scheduler picks
    // it up from here exactly as it would for any other pending job.
    expect((await jobs.getJobById(adopter.jobId))?.sourcePublishPendingSince).toBeDefined();
  });

  it("marks nothing for a private adopter — there is no obligation to schedule", async () => {
    const wasmHash = randomUUID().replace(/-/g, "").padEnd(64, "2");
    const { sourceSha256, uploadId: uploadA } = freshSource();
    const donor = await createDonor({ network: "mainnet", sourceSha256, uploadId: uploadA, wasmHash });

    const { uploadId: uploadB } = freshSource();
    const adopter = await createAdopter({ network: "testnet", visibility: "private", sourceSha256, uploadId: uploadB, wasmHash });

    await publish.completeArchiveObligationsForAdoptedJob(adopter, donor);

    expect((await jobs.getJobById(adopter.jobId))?.sourcePublishPendingSince).toBeUndefined();
  });

  it("marks nothing, and logs, when the donor carries no published result to locate", async () => {
    const wasmHash = randomUUID().replace(/-/g, "").padEnd(64, "3");
    const { sourceSha256, uploadId: uploadA } = freshSource();
    const undonor = await createAdopter({ network: "testnet", sourceSha256, uploadId: uploadA, wasmHash }); // never published

    const { uploadId: uploadB } = freshSource();
    const adopter = await createAdopter({ network: "testnet", visibility: "public", sourceSha256, uploadId: uploadB, wasmHash });

    await publish.completeArchiveObligationsForAdoptedJob(adopter, undonor);

    expect((await jobs.getJobById(adopter.jobId))?.sourcePublishPendingSince).toBeUndefined();
  });
});
