import { jest } from "@jest/globals";
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
  createPrismaClient,
  readDbEnv,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArchiveRecoveryScheduler } from "../src/modules/scheduler/archive-recovery.scheduler.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/** Work started without awaiting it must land before a module's shutdown closes the database under it. */

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;

// Fixtures and cleanup go through their own client, since each test closes the module it is testing.
let client: PrismaClient;
const createdRows = new CreatedRows();

beforeAll(async () => {
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = await mkdtemp(join(tmpdir(), "scvs-shutdown-detached-work-test-"));
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4995/public";
  process.env.SCVS_ARWEAVE_MODE = "dry-run";
  process.env.SCVS_ARWEAVE_GATEWAY_URL = "https://gateway.irys.xyz";
  client = createPrismaClient(readDbEnv());
});

afterAll(async () => {
  if (!client) return;
  try {
    await createdRows.cleanup(client);
  } finally {
    await client.$disconnect();
  }
});

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      ScheduleModule.forRoot(),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [ArweaveArchiveService, PublishService, ArchiveRecoveryScheduler, SourceResolutionService],
  }).compile();
}

/** A promise the test opens by hand, so nothing here depends on how long anything takes. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Records when the module's own client disconnects, which is the last thing its shutdown does. */
function recordDisconnect(moduleRef: TestingModule, events: string[]): void {
  const prisma = moduleRef.get<PrismaClient>(PRISMA_CLIENT);
  const disconnect = prisma.$disconnect.bind(prisma);
  jest.spyOn(prisma, "$disconnect").mockImplementation(async () => {
    events.push("database disconnected");
    await disconnect();
  });
}

/** A private testnet job with its verdict written, ready for `publishJobResult`. */
async function createComparedJob(): Promise<JobRecord> {
  const wasmHash = randomUUID().replace(/-/g, "").padEnd(64, "0");
  const sourceSha256 = randomUUID().replace(/-/g, "").padEnd(64, "1");
  const sourceRef = {
    type: "private_tarball" as const,
    visibility: "private" as const,
    upload_id: randomUUID(),
    tarball_sha256: sourceSha256,
    source_sha256: sourceSha256,
  };
  const jobs = new JobsRepository(client);
  const rebuilds = new RebuildsRepository(client);
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
      source_sha256: sourceSha256,
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
    result: { wasm_hash: wasmHash, matched: true, rebuilt_wasm_hash: wasmHash, status_summary: "verified" } as never,
  });
  return (await jobs.getJobById(job.jobId))!;
}

describe("closing the module waits for work nothing awaited", () => {
  it("lets a scheduled report archive record its outcome before the database disconnects", async () => {
    const job = await createComparedJob();
    const moduleRef = await buildModule();
    const events: string[] = [];
    recordDisconnect(moduleRef, events);

    const jobs = moduleRef.get(JobsRepository);
    const recordArchiveOutcome = jobs.recordArchiveOutcome.bind(jobs);
    jest.spyOn(jobs, "recordArchiveOutcome").mockImplementation(async (...args) => {
      await recordArchiveOutcome(...args);
      events.push("archive outcome recorded");
    });
    const upload = gate();
    const internals = moduleRef.get(ArweaveArchiveService) as unknown as {
      uploadToIrys: (kind: string, input: unknown) => Promise<unknown>;
    };
    const realUpload = internals.uploadToIrys.bind(internals);
    internals.uploadToIrys = async (kind, input) => {
      await upload.opened;
      return realUpload(kind, input);
    };

    let closing: Promise<void> | undefined;
    try {
      // Returns with the report archive scheduled and held at its upload.
      await moduleRef.get(PublishService).publishJobResult(job.jobId);
      closing = moduleRef.close();
      await new Promise((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);

      upload.open();
      await closing;
      expect(events).toEqual(["archive outcome recorded", "database disconnected"]);
    } finally {
      upload.open();
      await (closing ?? moduleRef.close());
    }
    const archived = await new JobsRepository(client).getJobById(job.jobId);
    expect(archived?.archivedTxId).toMatch(/^dryrun-/);
  });

  it("lets a retry an archive-recovery scan dispatched finish before the database disconnects", async () => {
    const moduleRef = await buildModule();
    const events: string[] = [];
    recordDisconnect(moduleRef, events);

    // Stubbed at the repository, so the scan never reads the shared table other suites write to.
    const pendingJob = { jobId: randomUUID() } as JobRecord;
    jest.spyOn(moduleRef.get(JobsRepository), "listJobsPendingArchive").mockResolvedValue([pendingJob]);
    const retry = gate();
    jest.spyOn(moduleRef.get(ArweaveArchiveService), "retryPendingArchive").mockImplementation(async (job) => {
      await retry.opened;
      events.push(`retried ${job.jobId}`);
    });

    let closing: Promise<void> | undefined;
    try {
      // Returns once the retry is dispatched, not once it is done.
      await moduleRef.get(ArchiveRecoveryScheduler).recoverPendingArchives();
      closing = moduleRef.close();
      await new Promise((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);

      retry.open();
      await closing;
      expect(events).toEqual([`retried ${pendingJob.jobId}`, "database disconnected"]);
    } finally {
      retry.open();
      await (closing ?? moduleRef.close());
    }
  });
});
