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
  ReportArchiveUploadsRepository,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { toResultUrl } from "@scvs/core";
import { createResultStorage, readWasmStatus } from "@scvs/storage-layout";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/**
 * Sibling of `source-archive-concurrent-dedup.spec.ts` (the source path). See
 * archive-and-recovery/decisions/report-archive-dedup-needs-a-claim-row-too.md for why this file exists.
 *
 * Deliberately not `SCVS_ARWEAVE_MODE=dry-run`: its `tx_id` is derived from `contentSha256`, so a real
 * double-spend would be invisible to a URL-count assertion. `uploadToIrys` is stubbed to a genuinely
 * random `tx_id` per call instead.
 */

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
let reportArchiveUploads: ReportArchiveUploadsRepository;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-report-archive-concurrent-dedup-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4999";
  // Not "dry-run" — see file header. uploadToIrys is stubbed per-test, so no real upload happens.
  process.env.SCVS_ARWEAVE_MODE = "irys";
  process.env.SCVS_ARWEAVE_NETWORK = "devnet";
  // A placeholder: getUploader() (the only reader) is never invoked, since findExistingUpload is stubbed
  // per-test and never falls through to it. Set only to satisfy env.dto.ts's boot-time validation.
  process.env.SCVS_ARWEAVE_WALLET_PRIVATE_KEY = "0x" + "1".repeat(64);
  process.env.SCVS_ARWEAVE_GATEWAY_URL = "https://gateway.irys.xyz";

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
  arweaveArchive = moduleRef.get(ArweaveArchiveService);
  reportArchiveUploads = moduleRef.get(ReportArchiveUploadsRepository);
  prisma = moduleRef.get(PRISMA_CLIENT);
});

afterAll(async () => {
  try {
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function archiveSettled(jobId: string): Promise<boolean> {
  const job = await jobs.getJobById(jobId);
  return job !== undefined && !job.archivePendingSince;
}

function freshWasmHash(): string {
  return randomUUID().replace(/-/g, "").padEnd(64, "0");
}

/** Every archive reference now on the published status object for this Wasm. */
async function archiveUrlsFor(wasmHash: string): Promise<string[]> {
  const storage = createResultStorage({
    kind: "filesystem",
    root: resultRoot,
    publicRoot: "http://localhost:4999",
  });
  const status = await readWasmStatus(storage, wasmHash);
  return (status?.source_code_verifications[0]?.results_urls ?? []).map((link) => toResultUrl(link).url);
}

/**
 * Advances a job to `comparing`, verified, with a fresh, unique wasm_hash — but does NOT publish it.
 * `result.artifact_sha256` (this content's `reportSha256`) is only assigned inside `publishJobResult`
 * itself, so every test below calls that explicitly, with its own stubs already in place first.
 */
async function createComparingJob(): Promise<JobRecord> {
  const wasmHash = freshWasmHash();

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
    rebuiltWasmHash: wasmHash,
  });

  await jobs.advanceJob(job.jobId, "queued", "comparing", {
    rebuildId: rebuild.rebuildId,
    verdict: "verified",
    result: {
      wasm_hash: wasmHash,
      matched: true,
      rebuilt_wasm_hash: wasmHash,
      status_summary: "verified",
    } as never,
  });

  return (await jobs.getJobById(job.jobId))!;
}

/** Reaches into the private methods, the same convention `archive-and-recovery.spec.ts` already uses. */
function internals(service: ArweaveArchiveService) {
  return service as unknown as {
    findExistingUpload: (kind: string, contentSha256: string) => Promise<{ tx_id: string; archive_url: string } | undefined>;
    uploadToIrys: (kind: string, input: unknown) => Promise<unknown>;
  };
}

/**
 * Publishes a job and waits for its live backfill to settle, with uploadToIrys/findExistingUpload
 * stubbed to a fast, guaranteed-success fake for the duration — `SCVS_ARWEAVE_MODE=irys` means the real
 * implementation would otherwise try to resolve an Ethereum wallet and query a real balance (see file
 * header for why this suite cannot use `dry-run` instead). Restores the real implementations before
 * returning, so a test's OWN stubbing (installed after this returns) is what governs its actual scenario.
 */
async function publishWithStubbedUpload(jobId: string): Promise<void> {
  const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
  const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
  internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
    kind === "report" ? undefined : realFind(kind, contentSha256);
  internals(arweaveArchive).uploadToIrys = async (kind, input) => {
    if (kind !== "report") return realUpload(kind, input);
    const txId = `real-upload-${randomUUID()}`;
    return { ok: true, tx_id: txId, archive_url: `https://gateway.irys.xyz/${txId}` };
  };

  try {
    await publish.publishJobResult(jobId);
    await waitUntil(() => archiveSettled(jobId), "the initial publish's live backfill to settle");
  } finally {
    internals(arweaveArchive).uploadToIrys = realUpload;
    internals(arweaveArchive).findExistingUpload = realFind;
  }
}

describe("report-archive concurrent dedup (report path's own claim, mirroring the source path)", () => {
  it("the live path and a concurrent recovery-tick retry, racing on the SAME report, produce exactly one real upload", async () => {
    const job = await createComparingJob();

    let uploadCalls = 0;
    const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
    const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
    // Never finds a pre-existing upload — forces both callers to actually race on uploadToIrys if the
    // claim were not serializing them.
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
      kind === "report" ? undefined : realFind(kind, contentSha256);
    internals(arweaveArchive).uploadToIrys = async (kind, input) => {
      if (kind !== "report") return realUpload(kind, input);
      uploadCalls += 1;
      // A small, randomised delay widens the window in which both concurrent callers are past
      // findOrCreate and mid-"upload" at once, and a genuinely random tx_id (not content-derived) is
      // what makes a real double-spend surface as two different URLs instead of two identical ones.
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
      const txId = `real-upload-${randomUUID()}`;
      return { ok: true, tx_id: txId, archive_url: `https://gateway.irys.xyz/${txId}` };
    };

    try {
      // publishJobResult schedules scheduleArweaveBackfill fire-and-forget (the live path) — reading
      // the freshly-published job back and firing a manual retryPendingArchive right after, before
      // either has resolved findOrCreate, is what makes this a real race on report_archive_uploads
      // rather than two calls that happen to run one after the other.
      await publish.publishJobResult(job.jobId);
      const published = (await jobs.getJobById(job.jobId))!;
      // Registered before any assertion below: a failing assertion must not leak the claim row into the
      // shared, never-reset Postgres (ADR-015).
      createdRows.reportArchiveUpload(published.result?.artifact_sha256);
      await Promise.all([
        waitUntil(() => archiveSettled(job.jobId), "the live path's own backfill to settle"),
        arweaveArchive.retryPendingArchive(published),
      ]);
      // A short settle window makes "exactly one" a real assertion, not a race the first waitUntil
      // happened to win — same pattern as archive-and-recovery.spec.ts's own 2026-08-05 regression test.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
      internals(arweaveArchive).findExistingUpload = realFind;
    }

    expect(uploadCalls).toBe(1);

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toMatch(/^real-upload-/);

    const reportSha256 = settled!.result!.artifact_sha256!;
    const claim = await reportArchiveUploads.getByReportSha256(reportSha256);
    expect(claim?.status).toBe("done");
    expect(claim?.txId).toBe(settled?.archivedTxId);
  });

  it("a claim stale past the timeout is released and re-claimed inline, not left stranded", async () => {
    const job = await createComparingJob();
    await publishWithStubbedUpload(job.jobId);
    const published = (await jobs.getJobById(job.jobId))!;
    const reportSha256 = published.result!.artifact_sha256!;
    createdRows.reportArchiveUpload(reportSha256);

    // Simulate "archived, but we forgot, and the claimant crashed mid-upload too": reset the job's own
    // pending flag and force the existing claim row back to "claimed" with a stale updatedAt.
    await jobs.updateJob(job.jobId, { archivePendingSince: new Date() });
    await prisma.reportArchiveUpload.update({
      where: { reportSha256 },
      data: { status: "claimed", txId: null, updatedAt: new Date(Date.now() - 10 * 60_000) }, // 10 minutes ago, past the 5-minute default
    });

    const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
    const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
      kind === "report" ? undefined : realFind(kind, contentSha256);
    internals(arweaveArchive).uploadToIrys = async (kind, input) => {
      if (kind !== "report") return realUpload(kind, input);
      const txId = `real-upload-${randomUUID()}`;
      return { ok: true, tx_id: txId, archive_url: `https://gateway.irys.xyz/${txId}` };
    };

    try {
      await arweaveArchive.retryPendingArchive(published);
      await waitUntil(() => archiveSettled(job.jobId), "the job to reclaim the stale claim and archive");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
      internals(arweaveArchive).findExistingUpload = realFind;
    }

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toMatch(/^real-upload-/);

    const claim = await reportArchiveUploads.getByReportSha256(reportSha256);
    expect(claim?.status).toBe("done");
    expect(claim?.txId).toBe(settled?.archivedTxId);
  });

  it("a done claim short-circuits: retryPendingArchive reuses it without calling findExistingUpload or uploadToIrys", async () => {
    const job = await createComparingJob();
    await publishWithStubbedUpload(job.jobId);
    const published = (await jobs.getJobById(job.jobId))!;
    const reportSha256 = published.result!.artifact_sha256!;
    createdRows.reportArchiveUpload(reportSha256);
    // Real, already-"done" state to reuse: the initial publish above already claimed and marked it done
    // via its own real (stubbed-random-tx_id) upload; simulate "archived, but we forgot" on top of that.
    await jobs.updateJob(job.jobId, { archivePendingSince: new Date() });

    let uploadCalls = 0;
    let findCalls = 0;
    const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
    const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
    internals(arweaveArchive).uploadToIrys = async (kind, input) => {
      if (kind === "report") uploadCalls += 1;
      return realUpload(kind, input);
    };
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) => {
      if (kind === "report") findCalls += 1;
      return realFind(kind, contentSha256);
    };

    try {
      await arweaveArchive.retryPendingArchive(published);
      await waitUntil(() => archiveSettled(job.jobId), "the done claim to be reused");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
      internals(arweaveArchive).findExistingUpload = realFind;
    }

    expect(uploadCalls).toBe(0);
    expect(findCalls).toBe(0);

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toBe(published.archivedTxId);

    const claim = await reportArchiveUploads.getByReportSha256(reportSha256);
    expect(claim?.txId).toBe(published.archivedTxId);
  });

  it("a failed upload releases its claim instead of leaving it stranded until the timeout", async () => {
    const job = await createComparingJob();

    const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
    const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
      kind === "report" ? undefined : realFind(kind, contentSha256);
    internals(arweaveArchive).uploadToIrys = async (kind, input) =>
      kind === "report"
        ? { ok: false, reason: "irys_upload_failed", detail: "stub: simulated network failure" }
        : realUpload(kind, input);

    let reportSha256: string;
    try {
      await publish.publishJobResult(job.jobId);
      await waitUntil(async () => {
        const current = await jobs.getJobById(job.jobId);
        return current !== undefined && current.archiveAttempts > 0;
      }, "the failed attempt to be recorded");
      reportSha256 = (await jobs.getJobById(job.jobId))!.result!.artifact_sha256!;
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
      internals(arweaveArchive).findExistingUpload = realFind;
    }
    createdRows.reportArchiveUpload(reportSha256);

    // Released, not stranded at "claimed": immediately queryable as gone, well under the 5-minute
    // stale-claim timeout the OTHER recovery path relies on.
    const claim = await reportArchiveUploads.getByReportSha256(reportSha256);
    expect(claim).toBeUndefined();

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toBeUndefined();
    expect(settled?.archivePendingSince).toBeDefined(); // still owed — the existing retry path picks it up later
  });

  it("an upload that outlives its own reaped claim still records its txId, rather than throwing it away", async () => {
    const job = await createComparingJob();

    const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
    const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
      kind === "report" ? undefined : realFind(kind, contentSha256);
    // Reaps this call's OWN claim from under it mid-upload — the shape a slow upload outliving
    // SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS produces, without waiting out a real 5-minute timeout.
    internals(arweaveArchive).uploadToIrys = async (kind, input) => {
      if (kind !== "report") return realUpload(kind, input);
      const sha = (input as { contentSha256: string }).contentSha256;
      await reportArchiveUploads.releaseClaim(sha);
      const txId = `paid-but-reaped-${randomUUID()}`;
      return { ok: true, tx_id: txId, archive_url: `https://gateway.irys.xyz/${txId}` };
    };

    let reportSha256: string;
    try {
      await publish.publishJobResult(job.jobId);
      reportSha256 = (await jobs.getJobById(job.jobId))!.result!.artifact_sha256!;
      createdRows.reportArchiveUpload(reportSha256);
      await waitUntil(() => archiveSettled(job.jobId), "the reaped-claim upload to still settle the job");
    } finally {
      internals(arweaveArchive).uploadToIrys = realUpload;
      internals(arweaveArchive).findExistingUpload = realFind;
    }

    // The obligation is discharged against the real, paid-for tx — not left pending for a second upload.
    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toMatch(/^paid-but-reaped-/);
    expect(settled?.archivePendingSince).toBeUndefined();
  });

  it('a "done" claim carrying no txId is discarded rather than published as a `/undefined` gateway URL', async () => {
    const job = await createComparingJob();
    await publishWithStubbedUpload(job.jobId);
    const published = (await jobs.getJobById(job.jobId))!;
    const reportSha256 = published.result!.artifact_sha256!;
    createdRows.reportArchiveUpload(reportSha256);

    // Corrupt the claim out-of-band: "done" with no txId, a state markDone cannot produce.
    await prisma.reportArchiveUpload.update({
      where: { reportSha256 },
      data: { status: "done", txId: null },
    });
    // `archivedTxId` is not on UpdateJobInput (only recordArchiveOutcome sets it), so clear it directly.
    await prisma.job.update({
      where: { id: job.jobId },
      data: { archivePendingSince: new Date(), archivedTxId: null },
    });

    await arweaveArchive.retryPendingArchive(published);

    // The corrupt row is gone, so the next attempt can re-archive from scratch...
    expect(await reportArchiveUploads.getByReportSha256(reportSha256)).toBeUndefined();
    // ...and the job stays owed rather than being settled against a bogus URL.
    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toBeUndefined();
    expect(settled?.archivePendingSince).toBeDefined();

    // Nothing resembling `${gateway}/undefined` reached the published status object.
    const urls = await archiveUrlsFor(published.target.wasm_hash!);
    expect(urls.some((url) => url.endsWith("/undefined"))).toBe(false);
  });
});
