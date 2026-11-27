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
  ReportArchiveUploadsRepository,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createResultStorage, readWasmStatus } from "@scvs/storage-layout";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";
import { StagedSourceReleaseService } from "../src/modules/source-resolution/staged-source-release.service.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;
const GATEWAY = "https://gateway.test";
const PUBLIC_ROOT = "http://localhost:4997";

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
let claims: ReportArchiveUploadsRepository;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();
const realFetch = globalThis.fetch;

// What the gateway reports: the current Arweave height, and the block each item landed in.
const gateway = { height: 1_000, blocks: new Map<string, number>() };
const uploads: string[] = [];
let foundUpload: string | undefined;
let receiptsCarryDeadline = true;

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-arweave-confirmation-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = PUBLIC_ROOT;
  process.env.SCVS_ARWEAVE_MODE = "turbo";
  process.env.SCVS_ARWEAVE_NETWORK = "mainnet";
  process.env.SCVS_ARWEAVE_CONFIRMATIONS = "3";
  process.env.SCVS_ARWEAVE_WALLET_PRIVATE_KEY = "0x" + "1".repeat(64);
  process.env.SCVS_ARWEAVE_GATEWAY_URL = GATEWAY;

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [ArweaveArchiveService, PublishService, SourceResolutionService, StagedSourceReleaseService],
  }).compile();

  jobs = moduleRef.get(JobsRepository);
  rebuilds = moduleRef.get(RebuildsRepository);
  publish = moduleRef.get(PublishService);
  arweaveArchive = moduleRef.get(ArweaveArchiveService);
  claims = moduleRef.get(ReportArchiveUploadsRepository);
  prisma = moduleRef.get(PRISMA_CLIENT);

  const internals = arweaveArchive as unknown as {
    findExistingUpload: () => Promise<undefined>;
    uploadToTurbo: () => Promise<unknown>;
  };
  internals.findExistingUpload = async () => (foundUpload ? { tx_id: foundUpload, archive_url: `${GATEWAY}/${foundUpload}` } : undefined) as undefined;
  internals.uploadToTurbo = async () => {
    const txId = `item-${uploads.length + 1}`;
    uploads.push(txId);
    return { ok: true, tx_id: txId, archive_url: `${GATEWAY}/${txId}`, ...(receiptsCarryDeadline ? { deadline_height: gateway.height + 10 } : {}) };
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(GATEWAY)) return realFetch(input, init);
    if (url === `${GATEWAY}/info`) return Response.json({ height: gateway.height });
    const { variables } = JSON.parse(String(init?.body)) as { variables: { id: string } };
    const height = gateway.blocks.get(variables.id);
    return Response.json({ data: { transaction: height === undefined ? null : { block: { height } } } });
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env.SCVS_ARWEAVE_CONFIRMATIONS;
  try {
    if (arweaveArchive) await arweaveArchive.onModuleDestroy();
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

beforeEach(() => {
  gateway.height = 1_000;
  gateway.blocks.clear();
  uploads.length = 0;
  foundUpload = undefined;
  receiptsCarryDeadline = true;
});

async function waitUntil(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function publishedJob(wasmHash: string): Promise<{ job: JobRecord; reportSha256: string }> {
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
  await rebuilds.markTerminal(rebuild.rebuildId, { outcome: "success", runner: "stellar_contract_verify", rebuiltWasmHash: wasmHash });
  await jobs.advanceJob(job.jobId, "queued", "comparing", {
    rebuildId: rebuild.rebuildId,
    verdict: "verified",
    result: { wasm_hash: wasmHash, matched: true, rebuilt_wasm_hash: wasmHash, status_summary: "verified" } as never,
  });
  await publish.publishJobResult(job.jobId);
  const published = (await jobs.getJobById(job.jobId))!;
  const reportSha256 = createdRows.reportArchiveUpload(published.result!.artifact_sha256!);
  await waitUntil(async () => (await claims.getByReportSha256(reportSha256))?.status === "uploaded", "the upload to be recorded");
  return { job: (await jobs.getJobById(job.jobId))!, reportSha256 };
}

async function arweaveLinks(wasmHash: string): Promise<string[]> {
  const storage = createResultStorage({ kind: "filesystem", root: resultRoot, publicRoot: PUBLIC_ROOT });
  const status = await readWasmStatus(storage, wasmHash);
  return (status?.source_code_verifications[0]?.results_urls ?? []).map((link) => toResultUrl(link).url).filter((url) => url.startsWith(GATEWAY));
}

describe("an archived report on mainnet is linked only once Arweave confirms it", () => {
  it("holds the job pending, and links nothing, while the bundler has it but Arweave does not", async () => {
    const wasmHash = `${"7".repeat(63)}1`;
    const { job, reportSha256 } = await publishedJob(wasmHash);

    expect(await claims.getByReportSha256(reportSha256)).toMatchObject({ status: "uploaded", txId: "item-1", deadlineHeight: 1_010 });
    expect(job.archivePendingSince).toBeDefined();
    expect(await arweaveLinks(wasmHash)).toEqual([]);

    gateway.blocks.set("item-1", 1_000);
    gateway.height = 1_001;
    await arweaveArchive.retryPendingArchive(job);
    expect((await jobs.getJobById(job.jobId))?.archivePendingSince).toBeDefined();
    expect(await arweaveLinks(wasmHash)).toEqual([]);
    expect(uploads).toEqual(["item-1"]);
  });

  it("links it, and clears the pending flag, once it has the configured confirmations", async () => {
    const wasmHash = `${"7".repeat(63)}2`;
    const { job, reportSha256 } = await publishedJob(wasmHash);

    gateway.blocks.set("item-1", 1_000);
    gateway.height = 1_002;
    await arweaveArchive.retryPendingArchive(job);

    const settled = await jobs.getJobById(job.jobId);
    expect(settled?.archivePendingSince).toBeUndefined();
    expect(settled?.archivedTxId).toBe("item-1");
    expect(await claims.getByReportSha256(reportSha256)).toMatchObject({ status: "done", txId: "item-1" });
    expect(await arweaveLinks(wasmHash)).toEqual([`${GATEWAY}/item-1`]);
    expect(uploads).toEqual(["item-1"]);
  });

  it("uploads it again when it is not on Arweave past its deadline height", async () => {
    const wasmHash = `${"7".repeat(63)}3`;
    const { job, reportSha256 } = await publishedJob(wasmHash);

    gateway.height = 1_011;
    await arweaveArchive.retryPendingArchive(job);
    expect(await claims.getByReportSha256(reportSha256)).toBeUndefined();

    await arweaveArchive.retryPendingArchive(job);
    expect(uploads).toEqual(["item-1", "item-2"]);
    expect(await claims.getByReportSha256(reportSha256)).toMatchObject({ status: "uploaded", txId: "item-2" });
    expect(await arweaveLinks(wasmHash)).toEqual([]);
  });

  it("does not count a wait for confirmation as a failed attempt", async () => {
    const wasmHash = `${"7".repeat(63)}4`;
    const { job } = await publishedJob(wasmHash);
    await arweaveArchive.retryPendingArchive(job);
    await arweaveArchive.retryPendingArchive(job);
    expect((await jobs.getJobById(job.jobId))?.archiveAttempts).toBe(0);
  });

  it("gives an item found already uploaded a deadline, so one that never lands is uploaded again", async () => {
    const wasmHash = `${"7".repeat(63)}5`;
    foundUpload = "found-elsewhere";
    const { job, reportSha256 } = await publishedJob(wasmHash);
    expect(await claims.getByReportSha256(reportSha256)).toMatchObject({ status: "uploaded", txId: "found-elsewhere", deadlineHeight: 1_200 });
    expect(uploads).toEqual([]);

    foundUpload = undefined;
    gateway.height = 1_201;
    await arweaveArchive.retryPendingArchive(job);
    await arweaveArchive.retryPendingArchive(job);
    expect(uploads).toEqual(["item-1"]);
  });

  it("gives an upload whose receipt had no deadline one on its first check, when the gateway answered nothing at upload", async () => {
    const wasmHash = `${"7".repeat(63)}6`;
    receiptsCarryDeadline = false;
    const realFetch2 = globalThis.fetch;
    let infoDown = true;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      infoDown && String(input) === `${GATEWAY}/info` ? new Response("down", { status: 503 }) : realFetch2(input, init)) as typeof fetch;
    try {
      const { job, reportSha256 } = await publishedJob(wasmHash);
      expect((await claims.getByReportSha256(reportSha256))?.deadlineHeight).toBeUndefined();

      infoDown = false;
      await arweaveArchive.retryPendingArchive(job);
      expect(await claims.getByReportSha256(reportSha256)).toMatchObject({ status: "uploaded", deadlineHeight: 1_200 });
    } finally {
      globalThis.fetch = realFetch2;
    }
  });
});
