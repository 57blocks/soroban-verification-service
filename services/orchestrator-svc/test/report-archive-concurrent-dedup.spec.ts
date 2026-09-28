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
  // Not dry-run: its content-derived `tx_id` would make a double upload invisible.
  process.env.SCVS_ARWEAVE_MODE = "irys";
  process.env.SCVS_ARWEAVE_NETWORK = "devnet";
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
    // Stop background archive work before deleting the rows it writes.
    if (arweaveArchive) await arweaveArchive.onModuleDestroy();
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

async function archiveUrlsFor(wasmHash: string): Promise<string[]> {
  const storage = createResultStorage({
    kind: "filesystem",
    root: resultRoot,
    publicRoot: "http://localhost:4999",
  });
  const status = await readWasmStatus(storage, wasmHash);
  return (status?.source_code_verifications[0]?.results_urls ?? []).map((link) => toResultUrl(link).url);
}

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

function internals(service: ArweaveArchiveService) {
  return service as unknown as {
    findExistingUpload: (kind: string, contentSha256: string) => Promise<{ tx_id: string; archive_url: string } | undefined>;
    uploadToIrys: (kind: string, input: unknown) => Promise<unknown>;
  };
}

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
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
      kind === "report" ? undefined : realFind(kind, contentSha256);
    internals(arweaveArchive).uploadToIrys = async (kind, input) => {
      if (kind !== "report") return realUpload(kind, input);
      uploadCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
      const txId = `real-upload-${randomUUID()}`;
      return { ok: true, tx_id: txId, archive_url: `https://gateway.irys.xyz/${txId}` };
    };

    try {
      await publish.publishJobResult(job.jobId);
      const published = (await jobs.getJobById(job.jobId))!;
      // Before any assertion, so a failure cannot leak the claim row into the shared database.
      createdRows.reportArchiveUpload(published.result?.artifact_sha256);
      await Promise.all([
        waitUntil(() => archiveSettled(job.jobId), "the live path's own backfill to settle"),
        arweaveArchive.retryPendingArchive(published),
      ]);
      // Settle window, so "exactly one" is not a race the `waitUntil` above happened to win.
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

    await jobs.updateJob(job.jobId, { archivePendingSince: new Date() });
    await prisma.reportArchiveUpload.update({
      where: { reportSha256 },
      data: { status: "claimed", txId: null, updatedAt: new Date(Date.now() - 10 * 60_000) }, // past the 5-minute stale-claim timeout
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

    const claim = await reportArchiveUploads.getByReportSha256(reportSha256);
    expect(claim).toBeUndefined();

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toBeUndefined();
    expect(settled?.archivePendingSince).toBeDefined();
  });

  it("an upload that outlives its own reaped claim still records its txId, rather than throwing it away", async () => {
    const job = await createComparingJob();

    const realUpload = internals(arweaveArchive).uploadToIrys.bind(arweaveArchive);
    const realFind = internals(arweaveArchive).findExistingUpload.bind(arweaveArchive);
    internals(arweaveArchive).findExistingUpload = async (kind, contentSha256) =>
      kind === "report" ? undefined : realFind(kind, contentSha256);
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

    await prisma.reportArchiveUpload.update({
      where: { reportSha256 },
      data: { status: "done", txId: null },
    });
    await prisma.job.update({
      where: { id: job.jobId },
      data: { archivePendingSince: new Date(), archivedTxId: null },
    });

    await arweaveArchive.retryPendingArchive(published);

    expect(await reportArchiveUploads.getByReportSha256(reportSha256)).toBeUndefined();
    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivedTxId).toBeUndefined();
    expect(settled?.archivePendingSince).toBeDefined();

    const urls = await archiveUrlsFor(published.target.wasm_hash!);
    expect(urls.some((url) => url.endsWith("/undefined"))).toBe(false);
  });
});
