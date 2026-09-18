import { toResultUrl } from "@scvs/core";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  DbModule,
  JobsRepository,
  PRISMA_CLIENT,
  RebuildsRepository,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createResultStorage, readWasmStatus } from "@scvs/storage-layout";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { ArchiveRecoveryScheduler } from "../src/modules/scheduler/archive-recovery.scheduler.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/**
 * Two things are real here and nowhere else: `JobsRepository`'s new archive-pending queries against actual
 * Postgres, and `ArweaveArchiveService`'s duplicate-content guard.
 */

const WASM_HASH = "3".repeat(64);
const REBUILT_HASH = WASM_HASH;
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;

const sourceRef = {
  type: "git" as const,
  visibility: "public" as const,
  repo: "https://github.com/example/example",
  rev: "a".repeat(40),
  source_sha256: "4".repeat(64),
};

let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let publish: PublishService;
let arweaveArchive: ArweaveArchiveService;
let scheduler: ArchiveRecoveryScheduler;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-archive-recovery-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4998";
  process.env.SCVS_ARWEAVE_MODE = "dry-run";
  // This assertion must depend only on what THIS test sets, never on ambient machine state.
  process.env.SCVS_ARWEAVE_GATEWAY_URL = "https://gateway.irys.xyz";

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [ArweaveArchiveService, PublishService, ArchiveRecoveryScheduler, SourceResolutionService],
  }).compile();

  jobs = moduleRef.get(JobsRepository);
  rebuilds = moduleRef.get(RebuildsRepository);
  publish = moduleRef.get(PublishService);
  arweaveArchive = moduleRef.get(ArweaveArchiveService);
  scheduler = moduleRef.get(ArchiveRecoveryScheduler);
  prisma = moduleRef.get(PRISMA_CLIENT);
});

// A suite removes what it created, and only what it created.
afterAll(async () => {
  // Locally that is invisible.
  if (scheduler) await waitForScanIdle();

  // `prisma` is unset when `beforeAll` threw; cleaning up then would bury the real error under a TypeError.
  try {
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

/** Blocks until no `retryPendingArchive` dispatched by a scan tick is still running. */
async function waitForScanIdle(): Promise<void> {
  const inFlight = (scheduler as unknown as { retryingJobIds: Set<string> }).retryingJobIds;
  const deadline = Date.now() + 10_000;
  while (inFlight.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `archive retries still in flight at teardown after 10s: ${[...inFlight].join(", ")}. ` +
          "Their prisma writes would land after Jest tears the environment down.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Polls until `condition` holds. `scheduleArweaveBackfill` and `recoverPendingArchives` both dispatch the
 * archive without awaiting it, so its postcondition is the only thing there is to observe.
 */
async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The archive obligation is discharged — `recordArchiveOutcome` cleared `archivePendingSince`. */
async function archiveSettled(jobId: string): Promise<boolean> {
  const job = await jobs.getJobById(jobId);
  return job !== undefined && !job.archivePendingSince;
}

/** One attempt has been made and recorded, whether it succeeded or failed. */
async function archiveAttempted(jobId: string): Promise<boolean> {
  return ((await jobs.getJobById(jobId))?.archiveAttempts ?? 0) >= 1;
}

/** Every archive reference now on the published status object for this Wasm. */
async function archiveUrlsFor(wasmHash: string): Promise<string[]> {
  const storage = createResultStorage({
    kind: "filesystem",
    root: resultRoot,
    publicRoot: "http://localhost:4998",
  });
  const status = await readWasmStatus(storage, wasmHash);
  return (status?.source_code_verifications[0]?.results_urls ?? []).map((link) => toResultUrl(link).url);
}

async function createVerifiedJob(): Promise<JobRecord> {
  return createJob({ matched: true });
}

async function createJob(opts: {
  matched: boolean;
  wasmHash?: string;
  rebuiltWasmHash?: string;
}): Promise<JobRecord> {
  const wasmHash = opts.wasmHash ?? WASM_HASH;
  const rebuiltWasmHash = opts.rebuiltWasmHash ?? (opts.matched ? REBUILT_HASH : "9".repeat(64));

  const job = await jobs.createJob({
    dryRun: false,
    jobId: createdRows.job(randomUUID()),
    target: { network: "testnet", wasm_hash: wasmHash },
    verificationMode: "metadata",
    sourceRef,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: "testnet", wasm_hash: wasmHash },
      bldimg: IMAGE,
      source_sha256: "b".repeat(64),
    } as never,
  });

  const rebuild = await rebuilds.findOrCreate({
    rebuildId: randomUUID(),
    idempotencyKey: randomUUID(),
    sourceRef,
    buildOptions: {},
    imageDigest: IMAGE,
    buildMode: "verify",
    mechanismReason: "on_chain_recipe_in_trusted_image",
  });
  await rebuilds.markTerminal(rebuild.rebuildId, {
    outcome: "success",
    runner: "stellar_contract_verify",
    rebuiltWasmHash,
  });

  await jobs.advanceJob(job.jobId, "queued", "comparing", {
    rebuildId: rebuild.rebuildId,
    verdict: opts.matched ? "verified" : "mismatched",
    result: {
      wasm_hash: wasmHash,
      matched: opts.matched,
      rebuilt_wasm_hash: rebuiltWasmHash,
      status_summary: opts.matched ? "verified" : "mismatch",
    } as never,
  });

  return (await jobs.getJobById(job.jobId))!;
}

describe("JobsRepository archive-pending queries", () => {
  it("listJobsPendingArchive returns only jobs with archivePendingSince set", async () => {
    const job = await createVerifiedJob();
    await jobs.updateJob(job.jobId, { archivePendingSince: new Date() });

    const pending = await jobs.listJobsPendingArchive();
    expect(pending.some((j) => j.jobId === job.jobId)).toBe(true);

    await jobs.recordArchiveOutcome(job.jobId, { archived: true, txId: "tx-cleared", statusLink: { state: "complete", advancePublished: true } });
    const afterClear = await jobs.listJobsPendingArchive();
    expect(afterClear.some((j) => j.jobId === job.jobId)).toBe(false);
  });

  it("recordArchiveOutcome({archived: true}) clears the pending timestamp and sets archivedTxId", async () => {
    const job = await createVerifiedJob();
    await jobs.updateJob(job.jobId, { archivePendingSince: new Date() });

    await jobs.recordArchiveOutcome(job.jobId, { archived: true, txId: "tx-success", statusLink: { state: "complete", advancePublished: true } });

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.archivePendingSince).toBeUndefined();
    expect(reloaded?.archivedTxId).toBe("tx-success");
  });

  it("recordArchiveOutcome({archived: false}) increments archiveAttempts and leaves archivePendingSince untouched", async () => {
    const job = await createVerifiedJob();
    const since = new Date();
    await jobs.updateJob(job.jobId, { archivePendingSince: since });

    await jobs.recordArchiveOutcome(job.jobId, { archived: false });
    await jobs.recordArchiveOutcome(job.jobId, { archived: false });

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.archiveAttempts).toBe(2);
    expect(reloaded?.archivePendingSince).toBeDefined();
    expect(reloaded?.archivedTxId).toBeUndefined();
  });
});

describe("published_updated_at (IMPLEMENTATION-SPEC §F.1 / BL1) — set on a real wasms/<hash>.json write only", () => {
  it("is set on first publish", async () => {
    const job = await createVerifiedJob();
    const before = await jobs.getJobById(job.jobId);
    expect(before?.publishedUpdatedAt).toBeUndefined();

    await publish.publishJobResult(job.jobId);

    const after = await jobs.getJobById(job.jobId);
    expect(after?.publishedUpdatedAt).toBeDefined();

    // `publishJobResult` always ends with an unawaited `scheduleArweaveBackfill`, and in this suite's dry-run
    // mode that backfill *succeeds*, so it finishes with a `prisma.job.update` (`recordArchiveOutcome`'s
    // `archived: true` branch).
    await waitUntil(() => archiveSettled(job.jobId), "this publish's backfill to settle");
  });

  it("is NOT advanced by ADR-014's no-op overwrite (existing verified, this verdict mismatched)", async () => {
    const wasmHash = "5".repeat(64);
    const verifiedJob = await createJob({ matched: true, wasmHash });
    await publish.publishJobResult(verifiedJob.jobId);
    // writePublication's own fire-and-forget archive backfill (dry-run mode, always "succeeds") also advances
    // this job's published_updated_at once, on its own schedule.
    await waitUntil(
      () => archiveSettled(verifiedJob.jobId),
      "the first publish's backfill to settle before capturing a published_updated_at baseline",
    );

    const afterFirstPublish = await jobs.getJobById(verifiedJob.jobId);
    const publishedUpdatedAtAfterFirst = afterFirstPublish?.publishedUpdatedAt;
    expect(publishedUpdatedAtAfterFirst).toBeDefined();

    const storage = (await import("@scvs/storage-layout")).createResultStorage({
      kind: "filesystem",
      root: resultRoot,
      publicRoot: "http://localhost:4998",
    });
    const statusAfterFirst = await readWasmStatus(storage, wasmHash);
    const mtimeAfterFirst = statusAfterFirst?.updated_at;

    await new Promise((resolve) => setTimeout(resolve, 20));

    const mismatchedJob = await createJob({ matched: false, wasmHash, rebuiltWasmHash: "6".repeat(64) });
    await publish.publishJobResult(mismatchedJob.jobId);

    // wasms/<hash>.json itself is untouched — still the first job's verified entry, byte-identical updated_at
    // (buildWasmStatus's own no-op branch returns `existing` unchanged).
    const statusAfterSecond = await readWasmStatus(storage, wasmHash);
    expect(statusAfterSecond?.source_code_verifications[0]?.status).toBe("verified");
    expect(statusAfterSecond?.updated_at).toBe(mtimeAfterFirst);

    // The SECOND job's own row never gets a published_updated_at — writePublication never wrote
    // wasms/<hash>.json on its behalf, so there is nothing for it to have advanced.
    const mismatchedReloaded = await jobs.getJobById(mismatchedJob.jobId);
    expect(mismatchedReloaded?.publishedUpdatedAt).toBeUndefined();

    // The FIRST job's own row is untouched by the second publish — this test only asserts the second job's own
    // bookkeeping is honest, not a cross-job side effect.
    const verifiedReloaded = await jobs.getJobById(verifiedJob.jobId);
    expect(verifiedReloaded?.publishedUpdatedAt).toBe(publishedUpdatedAtAfterFirst);

    // The second publish has its own unawaited backfill — same reason as the test above.
    await waitUntil(() => archiveSettled(mismatchedJob.jobId), "the second publish's backfill to settle");
  });
});

describe("ArweaveArchiveService — duplicate-content guard runs on every attempt", () => {
  /** Reaches into the private methods, the same convention `withBrokenPublishing` already uses. */
  function internals(service: ArweaveArchiveService) {
    return service as unknown as {
      findExistingUpload: (reportSha256: string) => Promise<{ tx_id: string; archive_url: string } | undefined>;
      uploadToIrys: (input: unknown) => Promise<unknown>;
      backfill: (...args: never[]) => Promise<unknown>;
    };
  }

  it("the live path (scheduleArweaveBackfill) calls findExistingUpload before uploading", async () => {
    const job = await createVerifiedJob();
    let findExistingUploadCalls = 0;
    const real = internals(arweaveArchive).findExistingUpload;
    internals(arweaveArchive).findExistingUpload = async (reportSha256: string) => {
      findExistingUploadCalls += 1;
      return real.call(arweaveArchive, reportSha256);
    };

    try {
      await publish.publishJobResult(job.jobId);
      // Inside the try, so the backfill finishes while the counting stub is still in place.
      await waitUntil(() => archiveSettled(job.jobId), "the live backfill to settle");
    } finally {
      internals(arweaveArchive).findExistingUpload = real;
    }

    expect(findExistingUploadCalls).toBe(1);

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.archivePendingSince).toBeUndefined();
    expect(reloaded?.archivedTxId).toMatch(/^dryrun-/);
  });

  it("a live attempt whose report content was already archived by another job reuses that upload instead of paying again", async () => {
    const job = await createVerifiedJob();
    const real = internals(arweaveArchive).findExistingUpload;
    let uploadToIrysCalls = 0;
    const realUpload = internals(arweaveArchive).uploadToIrys;
    internals(arweaveArchive).findExistingUpload = async () => ({
      tx_id: "tx-from-another-job",
      archive_url: "https://gateway.irys.xyz/tx-from-another-job",
    });
    internals(arweaveArchive).uploadToIrys = async (input: unknown) => {
      uploadToIrysCalls += 1;
      return realUpload.call(arweaveArchive, input);
    };

    try {
      await publish.publishJobResult(job.jobId);
      await waitUntil(() => archiveSettled(job.jobId), "the live backfill to settle");
    } finally {
      internals(arweaveArchive).findExistingUpload = real;
      internals(arweaveArchive).uploadToIrys = realUpload;
    }

    expect(uploadToIrysCalls).toBe(0);
    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.archivePendingSince).toBeUndefined();
    expect(reloaded?.archivedTxId).toBe("tx-from-another-job");
  });

  it("the retry path (retryPendingArchive) reuses this report's own claim, and skips both findExistingUpload and uploadToIrys", async () => {
    const job = await createVerifiedJob();
    await publish.publishJobResult(job.jobId);
    // The publish above schedules its own live backfill, which claims this reportSha256 in
    // report_archive_uploads and marks it "done" with a real (dry-run) txId — that claim, not
    // findExistingUpload, is now what a retry for the SAME report consults first (report-archive
    // claim dedup: archive-and-recovery/decisions/report-archive-dedup-needs-a-claim-row-too.md).
    await waitUntil(() => archiveSettled(job.jobId), "the initial publish's backfill to settle");
    const published = (await jobs.getJobById(job.jobId))!;
    const firstTxId = published.archivedTxId;
    expect(firstTxId).toMatch(/^dryrun-/);
    // Simulate "archived, but we forgot" — as if a prior attempt's recordArchiveOutcome never ran.
    await jobs.updateJob(job.jobId, { archivePendingSince: new Date() });

    let uploadToIrysCalls = 0;
    let findExistingUploadCalls = 0;
    const realUpload = internals(arweaveArchive).uploadToIrys;
    const realFind = internals(arweaveArchive).findExistingUpload;
    internals(arweaveArchive).uploadToIrys = async (input: unknown) => {
      uploadToIrysCalls += 1;
      return realUpload.call(arweaveArchive, input);
    };
    internals(arweaveArchive).findExistingUpload = async (...args: unknown[]) => {
      findExistingUploadCalls += 1;
      // Deliberately a DIFFERENT tx than firstTxId — proves the retry never reaches this call at all
      // (the claim short-circuits before findExistingUpload), rather than merely happening to agree.
      return { tx_id: "tx-should-never-be-used", archive_url: "https://gateway.irys.xyz/tx-should-never-be-used" };
    };

    try {
      await arweaveArchive.retryPendingArchive(published);
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
      internals(arweaveArchive).findExistingUpload = realFind;
    }

    expect(uploadToIrysCalls).toBe(0);
    expect(findExistingUploadCalls).toBe(0);
    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.archivePendingSince).toBeUndefined();
    expect(reloaded?.archivedTxId).toBe(firstTxId);
  });

  it("kill-and-recover: a failed live attempt leaves archivePendingSince set, and a later retry completes it", async () => {
    const job = await createVerifiedJob();

    const realUpload = internals(arweaveArchive).uploadToIrys;
    internals(arweaveArchive).uploadToIrys = async () => ({
      ok: false,
      reason: "irys_upload_failed",
      detail: "stub: simulated crash",
    });

    try {
      await publish.publishJobResult(job.jobId);
      await waitUntil(() => archiveAttempted(job.jobId), "the failed attempt to be recorded");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
    }

    const afterFailedAttempt = await jobs.getJobById(job.jobId);
    expect(afterFailedAttempt?.archivePendingSince).toBeDefined();
    expect(afterFailedAttempt?.archivedTxId).toBeUndefined();
    expect(afterFailedAttempt?.archiveAttempts).toBeGreaterThanOrEqual(1);

    // The recovery scan's tick, run directly (not waiting for the real @Interval timer). recoverPendingArchives
    // still fires retryPendingArchive off without awaiting it per job (ArchiveRecoveryScheduler's own doc
    // comment), so the outer await only waits for the scan loop to finish dispatching, not for the archive
    // itself to settle.
    await scheduler.recoverPendingArchives();
    await waitUntil(() => archiveSettled(job.jobId), "the recovered archive to settle");

    const afterRecovery = await jobs.getJobById(job.jobId);
    expect(afterRecovery?.archivePendingSince).toBeUndefined();
    expect(afterRecovery?.archivedTxId).toMatch(/^dryrun-/);
  });

  it("re-delivers a recovered archive after its pre-backfill cursor, so a mirror upserts one hash", async () => {
    // PUB-12's service-side half. The real publisher, Postgres repository, recovery scheduler and status-object
    // writer run here; only the Irys boundary is controlled to fail once then succeed.
    const wasmHash = `${"8".repeat(63)}c`;
    const job = await createJob({ matched: true, wasmHash });
    let uploadAttempts = 0;
    const realUpload = internals(arweaveArchive).uploadToIrys;
    internals(arweaveArchive).uploadToIrys = async () => {
      uploadAttempts += 1;
      return uploadAttempts === 1
        ? { ok: false, reason: "irys_upload_failed", detail: "controlled first-attempt failure" }
        : {
            ok: true,
            tx_id: "tx-pub-12-recovered",
            archive_url: "https://gateway.irys.xyz/tx-pub-12-recovered",
          };
    };

    let initialUpdatedAt: string;
    let initialUrls: string[];
    try {
      await publish.publishJobResult(job.jobId);
      await waitUntil(() => archiveAttempted(job.jobId), "the controlled archive failure to be recorded");

      const afterFailure = (await jobs.getJobById(job.jobId))!;
      expect(afterFailure.archivePendingSince).toBeDefined();
      expect(afterFailure.publishedUpdatedAt).toBeDefined();
      initialUpdatedAt = afterFailure.publishedUpdatedAt!;
      initialUrls = await archiveUrlsFor(wasmHash);
      expect(initialUrls).toHaveLength(1);
      expect(initialUrls.some((url) => url.startsWith("https://gateway.irys.xyz/"))).toBe(false);

      // BL1 uses milliseconds. Ensure the recovered write receives a strictly later key than C0, rather than
      // depending on two real writes happening to span a clock tick.
      const initialMs = new Date(initialUpdatedAt).getTime();
      await waitUntil(async () => Date.now() > initialMs, "the next publication-update millisecond");

      await scheduler.recoverPendingArchives();
      await waitUntil(() => archiveSettled(job.jobId), "the recovered archive to settle");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
    }

    expect(uploadAttempts).toBe(2);
    const recovered = (await jobs.getJobById(job.jobId))!;
    expect(recovered.publishedUpdatedAt).toBeDefined();
    expect(new Date(recovered.publishedUpdatedAt!).getTime()).toBeGreaterThan(new Date(initialUpdatedAt!).getTime());

    const recoveredUrls = await archiveUrlsFor(wasmHash);
    expect(recoveredUrls).toEqual([
      initialUrls![0],
      "https://gateway.irys.xyz/tx-pub-12-recovered",
    ]);

    const redelivered = await jobs.listPublished({
      order: "asc",
      limit: 200,
      cursor: { timestampMs: new Date(initialUpdatedAt!).getTime(), wasmHash },
    });
    const record = redelivered.find((entry) => entry.wasmHash === wasmHash);
    expect(record).toEqual({ wasmHash, publishedUpdatedAt: recovered.publishedUpdatedAt });

    // A bulk record tells the mirror that H changed; the mirror re-reads its static status object and upserts
    // by H.
    const mirror = new Map<string, { updatedAt: string; urls: string[] }>();
    mirror.set(wasmHash, { updatedAt: initialUpdatedAt!, urls: initialUrls! });
    mirror.set(record!.wasmHash, { updatedAt: record!.publishedUpdatedAt, urls: recoveredUrls });
    expect(mirror).toEqual(
      new Map([[wasmHash, { updatedAt: recovered.publishedUpdatedAt!, urls: recoveredUrls }]]),
    );
  });

  it("regression (2026-08-07, F2): a second recovery tick does not re-dispatch a job whose retry from the first tick is still in flight", async () => {
    // Reproduces the actual finding: with a large backlog, @Interval fires again before the previous tick's
    // unawaited retryPendingArchive calls finish.
    const job = await createVerifiedJob();

    const realUpload = internals(arweaveArchive).uploadToIrys;
    internals(arweaveArchive).uploadToIrys = async () => ({
      ok: false,
      reason: "irys_upload_failed",
      detail: "stub: simulated crash",
    });
    try {
      await publish.publishJobResult(job.jobId);
      await waitUntil(() => archiveAttempted(job.jobId), "the failed live attempt to be recorded");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
    }
    const pending = await jobs.getJobById(job.jobId);
    expect(pending?.archivePendingSince).toBeDefined();

    // findExistingUpload never finds anything (simulates indexer lag: the in-flight upload below hasn't been
    // indexed yet), and uploadToIrys hangs until released.
    const realFind = internals(arweaveArchive).findExistingUpload;
    internals(arweaveArchive).findExistingUpload = async () => undefined;
    let uploadCalls = 0;
    let releaseUpload: (() => void) | undefined;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    internals(arweaveArchive).uploadToIrys = async () => {
      uploadCalls += 1;
      await uploadGate;
      return { ok: true, tx_id: "tx-only-once", archive_url: "https://gateway.irys.xyz/tx-only-once" };
    };

    try {
      await scheduler.recoverPendingArchives(); // first tick: dispatches retryPendingArchive, not awaited
      await scheduler.recoverPendingArchives(); // second tick, "next @Interval fires" — same job still pending
      // Wait for the condition, not a guessed duration: first tick's dispatch crosses real DB round-trips
      // (findOrCreate) before reaching the mocked uploadToIrys, and a fixed sleep races that under CI load.
      await waitUntil(() => Promise.resolve(uploadCalls >= 1), "the first tick's dispatch to reach uploadToIrys");
      await new Promise((resolve) => setTimeout(resolve, 20)); // let the second tick's dispatch loop run too
      expect(uploadCalls).toBe(1); // the guard, not a race, is what keeps this at 1

      releaseUpload?.();
      await waitUntil(() => archiveSettled(job.jobId), "the single in-flight upload to settle");
    } finally {
      internals(arweaveArchive).findExistingUpload = realFind;
      internals(arweaveArchive).uploadToIrys = realUpload;
      releaseUpload?.();
    }

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toBe("tx-only-once");
  });

  it("never blocks publish: a permanently failing archive still lets the job reach published", async () => {
    const job = await createVerifiedJob();
    const realUpload = internals(arweaveArchive).uploadToIrys;
    internals(arweaveArchive).uploadToIrys = async () => ({
      ok: false,
      reason: "irys_upload_failed",
      detail: "stub: permanently broken",
    });

    try {
      await publish.publishJobResult(job.jobId);
      await waitUntil(() => archiveAttempted(job.jobId), "the doomed attempt to be recorded");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
    }

    const reloaded = await jobs.getJobById(job.jobId);
    expect(reloaded?.status).toBe("published");
  });

  it("appends a fetchable gateway URL (not an ar:// URI) to wasms/<hash>.json on success", async () => {
    const job = await createVerifiedJob();
    await publish.publishJobResult(job.jobId);
    await waitUntil(() => archiveSettled(job.jobId), "the archive URL to be appended");

    const urls = await archiveUrlsFor(WASM_HASH);
    expect(urls.some((url) => url.startsWith("https://gateway.irys.xyz/"))).toBe(true);
    expect(urls.some((url) => url.startsWith("ar://"))).toBe(false);
  });

  it("regression (2026-08-05): a real concurrent duplicate publish of the SAME job never leaves two archive URLs behind", async () => {
    // The original bug report: the immediate batch-event path and PublishRecoveryScheduler's recovery scan
    // could both call publishJobResult(jobId) for the same job before either had written status: "published".
    const job = await createVerifiedJob();

    let completedBackfills = 0;
    const realBackfill = internals(arweaveArchive).backfill;
    internals(arweaveArchive).backfill = async (...args: never[]) => {
      try {
        return await realBackfill.apply(arweaveArchive, args);
      } finally {
        completedBackfills += 1;
      }
    };

    try {
      await Promise.all([publish.publishJobResult(job.jobId), publish.publishJobResult(job.jobId)]);
      await waitUntil(async () => completedBackfills >= 1, "the backfill to settle");
      // A short settle window makes "exactly one" a real assertion rather than a race the first `waitUntil`
      // happened to win.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completedBackfills).toBe(1);
    } finally {
      internals(arweaveArchive).backfill = realBackfill;
    }

    // And exactly one report object, not two with different `verified_at`s for one verdict.
    expect((await jobs.getJobById(job.jobId))?.status).toBe("published");

    const urls = await archiveUrlsFor(WASM_HASH);
    const archiveUrls = urls.filter((url) => url.startsWith("https://gateway.irys.xyz/"));

    expect(archiveUrls.length).toBeLessThanOrEqual(1);
    // Exactly two elements when an archive completed: [reportUrl, archiveUrl] — never a growing array of stale
    // entries from whichever of the two concurrent publishes ran first.
    expect(urls.length).toBeLessThanOrEqual(2);
  });
});

describe("archive_backlog gauge (O4)", () => {
  /**
   * Reaches into the private `metrics` field, the same convention `internals()` above uses for
   * ArweaveArchiveService's private methods.
   */
  function metricsOf(service: ArchiveRecoveryScheduler) {
    return (service as unknown as { metrics: { gauge: (name: string, value: number) => void } }).metrics;
  }

  it("emits archive_backlog sized from listJobsPendingArchive on every scan tick", async () => {
    const jobA = await createVerifiedJob();
    const jobB = await createVerifiedJob();
    await jobs.updateJob(jobA.jobId, { archivePendingSince: new Date() });
    await jobs.updateJob(jobB.jobId, { archivePendingSince: new Date() });

    const gaugeCalls: { name: string; value: number }[] = [];
    const real = metricsOf(scheduler).gauge;
    metricsOf(scheduler).gauge = (name, value) => {
      gaugeCalls.push({ name, value });
      return real.call(metricsOf(scheduler), name, value);
    };

    try {
      await scheduler.recoverPendingArchives();
    } finally {
      metricsOf(scheduler).gauge = real;
    }

    const archiveBacklogCalls = gaugeCalls.filter((call) => call.name === "archive_backlog");
    expect(archiveBacklogCalls).toHaveLength(1);
    expect(archiveBacklogCalls[0].value).toBeGreaterThanOrEqual(2);

    const actualPending = await jobs.listJobsPendingArchive();
    expect(archiveBacklogCalls[0].value).toBe(actualPending.length);
  });

  it("emits archive_backlog on an empty tick too — silence must not read as zero backlog", async () => {
    // Drain whatever this test file's own fixtures left pending, so this tick's count is knowable.
    const pending = await jobs.listJobsPendingArchive();
    await Promise.all(
      pending.map((job) => jobs.recordArchiveOutcome(job.jobId, { archived: true, txId: "tx-drained-for-test", statusLink: { state: "complete", advancePublished: true } })),
    );

    const gaugeCalls: { name: string; value: number }[] = [];
    const real = metricsOf(scheduler).gauge;
    metricsOf(scheduler).gauge = (name, value) => {
      gaugeCalls.push({ name, value });
      return real.call(metricsOf(scheduler), name, value);
    };

    try {
      await scheduler.recoverPendingArchives();
    } finally {
      metricsOf(scheduler).gauge = real;
    }

    const archiveBacklogCalls = gaugeCalls.filter((call) => call.name === "archive_backlog");
    expect(archiveBacklogCalls).toHaveLength(1);
    expect(archiveBacklogCalls[0].value).toBe(0);
  });
});
