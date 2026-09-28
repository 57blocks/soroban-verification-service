import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import {
  DbModule,
  JobsRepository,
  PRISMA_CLIENT,
  RebuildsRepository,
  SourceArchiveUploadsRepository,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createResultStorage, sourceKeyFromFileName } from "@scvs/storage-layout";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;

let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let publish: PublishService;
let arweaveArchive: ArweaveArchiveService;
let sourceArchiveUploads: SourceArchiveUploadsRepository;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-source-archive-concurrent-dedup-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4997/public";
  process.env.SCVS_ARWEAVE_MODE = "dry-run";
  process.env.SCVS_ARWEAVE_GATEWAY_URL = "https://gateway.irys.xyz";
  process.env.SCVS_SOURCE_ARCHIVE_ENABLED = "true";

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      ScheduleModule.forRoot(),
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
  sourceArchiveUploads = moduleRef.get(SourceArchiveUploadsRepository);
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

async function sourceArchiveSettled(jobId: string): Promise<boolean> {
  const job = await jobs.getJobById(jobId);
  return job !== undefined && !job.sourceArchivePendingSince;
}

function resultStorage() {
  return createResultStorage({
    kind: "filesystem",
    root: resultRoot,
    publicRoot: "http://localhost:4997/public",
  });
}

async function stageDurableSource(sourceFileName: string): Promise<void> {
  await resultStorage().writeBytes(
    sourceKeyFromFileName(sourceFileName),
    new TextEncoder().encode("fixture bytes"),
    "application/octet-stream",
  );
}

function freshWasmHash(): string {
  return randomUUID().replace(/-/g, "").padEnd(64, "0");
}

async function publishMainnetJob(opts: { sourceSha256: string; wasmHash: string }): Promise<JobRecord> {
  const sourceFileName = `${opts.sourceSha256}.tar.gz`;
  await stageDurableSource(sourceFileName);

  const sourceRef = {
    type: "source_uri" as const,
    visibility: "public" as const,
    source_uri: "https://example.com/fixture.tar.gz",
    source_sha256: opts.sourceSha256,
  };

  const job = await jobs.createJob({
    dryRun: false,
    jobId: createdRows.job(randomUUID()),
    target: { network: "mainnet", wasm_hash: opts.wasmHash },
    verificationMode: "metadata",
    sourceRef,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: "mainnet", wasm_hash: opts.wasmHash },
      bldimg: IMAGE,
      source_sha256: opts.sourceSha256,
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
  return (await jobs.getJobById(job.jobId))!;
}

describe("source-archive concurrent dedup", () => {
  it("two jobs sharing one source_sha256, published back to back, produce exactly one Irys upload", async () => {
    const sourceSha256 = createdRows.sourceArchiveUpload(randomUUID().replace(/-/g, "").padEnd(64, "0"));

    let sourceUploadCalls = 0;
    const internals = arweaveArchive as unknown as {
      uploadToIrys: (kind: string, input: unknown) => Promise<unknown>;
    };
    const realUpload = internals.uploadToIrys.bind(arweaveArchive);
    internals.uploadToIrys = async (kind, input) => {
      if (kind === "source") sourceUploadCalls += 1;
      return realUpload(kind, input);
    };

    try {
      const [jobA, jobB] = await Promise.all([
        publishMainnetJob({ sourceSha256, wasmHash: freshWasmHash() }),
        publishMainnetJob({ sourceSha256, wasmHash: freshWasmHash() }),
      ]);

      const deadline = Date.now() + 4_000;
      while (!(await sourceArchiveSettled(jobA.jobId)) || !(await sourceArchiveSettled(jobB.jobId))) {
        if (Date.now() > deadline) throw new Error("timed out driving both jobs' source archive to settle");
        for (const job of [jobA, jobB]) {
          const current = (await jobs.getJobById(job.jobId))!;
          if (current.sourceArchivePendingSince) await arweaveArchive.retryPendingSourceArchive(current);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(sourceUploadCalls).toBe(1);

      const settledA = await jobs.getJobById(jobA.jobId);
      const settledB = await jobs.getJobById(jobB.jobId);
      expect(settledA?.sourceArchivedTxId).toBeDefined();
      expect(settledA?.sourceArchivedTxId).toBe(settledB?.sourceArchivedTxId);
    } finally {
      internals.uploadToIrys = realUpload;
    }
  });

  it("a claim stale past the timeout is released and re-claimed inline, not left stranded", async () => {
    const sourceSha256 = createdRows.sourceArchiveUpload(randomUUID().replace(/-/g, "").padEnd(64, "0"));

    await sourceArchiveUploads.findOrCreate(sourceSha256);
    await prisma.sourceArchiveUpload.update({
      where: { sourceSha256 },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) }, // past the 5-minute stale-claim timeout
    });

    const job = await publishMainnetJob({ sourceSha256, wasmHash: freshWasmHash() });

    await waitUntil(() => sourceArchiveSettled(job.jobId), "the job to reclaim the stale claim and archive");

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.sourceArchivedTxId).toBeDefined();

    const claim = await sourceArchiveUploads.getBySourceSha256(sourceSha256);
    expect(claim?.status).toBe("done");
    expect(claim?.txId).toBe(settled?.sourceArchivedTxId);
  });

  it("the claim's winner still checks findExistingUpload before paying — insurance against an upload this table never recorded", async () => {
    const sourceSha256 = createdRows.sourceArchiveUpload(randomUUID().replace(/-/g, "").padEnd(64, "0"));

    let sourceUploadCalls = 0;
    const internals = arweaveArchive as unknown as {
      uploadToIrys: (kind: string, input: unknown) => Promise<unknown>;
      findExistingUpload: (kind: string, contentSha256: string) => Promise<{ tx_id: string; archive_url: string } | undefined>;
    };
    const realUpload = internals.uploadToIrys.bind(arweaveArchive);
    const realFind = internals.findExistingUpload.bind(arweaveArchive);
    internals.uploadToIrys = async (kind, input) => {
      if (kind === "source") sourceUploadCalls += 1;
      return realUpload(kind, input);
    };
    internals.findExistingUpload = async (kind, contentSha256) =>
      kind === "source" ? { tx_id: "tx-preexisting", archive_url: "https://gateway.irys.xyz/tx-preexisting" } : realFind(kind, contentSha256);

    try {
      const job = await publishMainnetJob({ sourceSha256, wasmHash: freshWasmHash() });
      await waitUntil(() => sourceArchiveSettled(job.jobId), "the winner to settle via findExistingUpload");

      expect(sourceUploadCalls).toBe(0);
      const settled = await jobs.getJobById(job.jobId);
      expect(settled?.sourceArchivedTxId).toBe("tx-preexisting");

      const claim = await sourceArchiveUploads.getBySourceSha256(sourceSha256);
      expect(claim?.status).toBe("done");
      expect(claim?.txId).toBe("tx-preexisting");
    } finally {
      internals.uploadToIrys = realUpload;
      internals.findExistingUpload = realFind;
    }
  });

  it("a failed upload releases its claim instead of leaving it stranded until the timeout", async () => {
    const sourceSha256 = createdRows.sourceArchiveUpload(randomUUID().replace(/-/g, "").padEnd(64, "0"));

    const internals = arweaveArchive as unknown as {
      uploadToIrys: (kind: string, input: unknown) => Promise<unknown>;
    };
    const realUpload = internals.uploadToIrys.bind(arweaveArchive);
    internals.uploadToIrys = async (kind, input) =>
      kind === "source"
        ? { ok: false, reason: "irys_upload_failed", detail: "stub: simulated network failure" }
        : realUpload(kind, input);

    try {
      const job = await publishMainnetJob({ sourceSha256, wasmHash: freshWasmHash() });
      await waitUntil(async () => {
        const current = await jobs.getJobById(job.jobId);
        return current !== undefined && current.sourceArchiveAttempts > 0;
      }, "the failed attempt to be recorded");

      const claim = await sourceArchiveUploads.getBySourceSha256(sourceSha256);
      expect(claim).toBeUndefined();

      const settled = await jobs.getJobById(job.jobId);
      expect(settled?.sourceArchivedTxId).toBeUndefined();
      expect(settled?.sourceArchivePendingSince).toBeDefined();
    } finally {
      internals.uploadToIrys = realUpload;
    }
  });
});
