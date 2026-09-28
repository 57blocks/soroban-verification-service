import { randomBytes, randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { DrainState, type Network } from "@scvs/core";
import {
  DbModule,
  JobsRepository,
  PRISMA_CLIENT,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { BuildDispatchScheduler } from "../src/modules/scheduler/build-dispatch.scheduler.js";
import { WorkerTickState } from "../src/common/worker-tick.module.js";
import { StartupRecoveryService } from "../src/modules/scheduler/startup-recovery.service.js";
import { VerificationPipelineService } from "../src/modules/verification-pipeline/verification-pipeline.service.js";

class RecordingPipeline {
  readonly handled: string[] = [];
  async run(job: JobRecord): Promise<void> {
    this.handled.push(job.jobId);
  }
}

class HoldingPipeline {
  readonly handled: string[] = [];
  private readonly pending = new Map<string, () => void>();
  async run(job: JobRecord): Promise<void> {
    this.handled.push(job.jobId);
    await new Promise<void>((resolve) => this.pending.set(job.jobId, resolve));
  }
  release(jobId: string): void {
    this.pending.get(jobId)?.();
    this.pending.delete(jobId);
  }
  releaseAll(): void {
    for (const jobId of [...this.pending.keys()]) this.release(jobId);
  }
}

class NoopStartupRecovery {
  async onModuleInit(): Promise<void> {}
}

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;

/** The loop frees a slot in a `.finally` after an unawaited dispatch, so it is free only one macrotask later. */
function flushDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function buildSchedulerHarness(pipeline: {
  run: VerificationPipelineService["run"];
  releaseAll?: () => void;
}): Promise<{
  jobs: JobsRepository;
  scheduler: BuildDispatchScheduler;
  prisma: PrismaClient;
  moduleRef: TestingModule;
  createdRows: CreatedRows;
  createJob: (network: Network) => Promise<string>;
  cleanup: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ScheduleModule.forRoot(),
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) =>
          configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [
      BuildDispatchScheduler,
      DrainState,
      WorkerTickState,
      { provide: VerificationPipelineService, useValue: pipeline },
      { provide: StartupRecoveryService, useValue: new NoopStartupRecovery() },
    ],
  }).compile();

  const jobs = moduleRef.get(JobsRepository);
  const scheduler = moduleRef.get(BuildDispatchScheduler);
  const prisma = moduleRef.get(PRISMA_CLIENT);
  const createdRows = new CreatedRows();

  const visible = new Set<string>();

  const listJobsByStatus = jobs.listJobsByStatus.bind(jobs);
  jobs.listJobsByStatus = async (statuses) =>
    (await listJobsByStatus(statuses)).filter((job) => visible.has(job.jobId));

  async function createJob(network: Network): Promise<string> {
    const jobId = createdRows.job(randomUUID());
    const sourceSha256 = randomBytes(32).toString("hex");
    await jobs.createJob({
      dryRun: false,
      jobId,
      target: { network, contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}` },
      verificationMode: "submitted",
      sourceRef: {
        type: "source_uri",
        visibility: "public",
        source_uri: "https://example.com/fairness.tar.gz",
        source_sha256: sourceSha256,
      },
      buildOptions: { bldopt: [], bldarg: [] },
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        bldimg: IMAGE,
        source_sha256: sourceSha256,
        source_uri: "https://example.com/fairness.tar.gz",
      } as never,
    });
    visible.add(jobId);
    return jobId;
  }

  async function cleanup(): Promise<void> {
    try {
      await createdRows.cleanup(prisma);
    } finally {
      // `close()` waits for every dispatched step, so release held jobs first or it hangs.
      pipeline.releaseAll?.();
      await moduleRef.close();
    }
  }

  return { jobs, scheduler, prisma, moduleRef, createdRows, createJob, cleanup };
}

describe("BuildDispatchScheduler fairness", () => {
  let harness: Awaited<ReturnType<typeof buildSchedulerHarness>>;
  let pipeline: RecordingPipeline;

  beforeAll(async () => {
    pipeline = new RecordingPipeline();
    harness = await buildSchedulerHarness(pipeline);
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  it("gives every active job a turn instead of replaying the oldest one every tick", async () => {
    const first = await harness.createJob("testnet");
    const second = await harness.createJob("testnet");
    const third = await harness.createJob("testnet");

    for (let i = 0; i < 3; i++) {
      await harness.scheduler.pollOnce();
      await flushDispatch();
    }

    const handled = new Set(pipeline.handled);
    expect(handled.has(first)).toBe(true);
    expect(handled.has(second)).toBe(true);
    expect(handled.has(third)).toBe(true);
  });

  it("still respects the concurrency cap within a single tick", async () => {
    await harness.createJob("testnet");
    await harness.createJob("testnet");
    await flushDispatch();
    pipeline.handled.length = 0;

    await harness.scheduler.pollOnce();

    expect(pipeline.handled).toHaveLength(1);
  });
});

/** `configuration()` reads these variables once, when each harness module compiles. */
describe("BuildDispatchScheduler per-network admission ceiling", () => {
  const originalConcurrency = process.env.SCVS_WORKER_CONCURRENCY;
  const originalTestnetConcurrency = process.env.SCVS_WORKER_CONCURRENCY_TESTNET;

  afterEach(() => {
    if (originalConcurrency === undefined) delete process.env.SCVS_WORKER_CONCURRENCY;
    else process.env.SCVS_WORKER_CONCURRENCY = originalConcurrency;
    if (originalTestnetConcurrency === undefined) delete process.env.SCVS_WORKER_CONCURRENCY_TESTNET;
    else process.env.SCVS_WORKER_CONCURRENCY_TESTNET = originalTestnetConcurrency;
  });

  it("still admits a mainnet job while testnet has already filled its ceiling", async () => {
    process.env.SCVS_WORKER_CONCURRENCY = "2";
    process.env.SCVS_WORKER_CONCURRENCY_TESTNET = "1";
    const pipeline = new HoldingPipeline();
    const harness = await buildSchedulerHarness(pipeline);

    try {
      const testnetFirst = await harness.createJob("testnet");
      const testnetSecond = await harness.createJob("testnet");
      const mainnetJob = await harness.createJob("mainnet");

      await harness.scheduler.pollOnce();
      await flushDispatch();

      const handledAfterTick1 = new Set(pipeline.handled);
      expect(handledAfterTick1.has(testnetFirst)).toBe(true);
      expect(handledAfterTick1.has(mainnetJob)).toBe(true);
      expect(handledAfterTick1.has(testnetSecond)).toBe(false);

      await harness.scheduler.pollOnce();
      await flushDispatch();
      expect(new Set(pipeline.handled).has(testnetSecond)).toBe(false);

      pipeline.release(mainnetJob);
      await harness.scheduler.pollOnce();
      await flushDispatch();
      expect(new Set(pipeline.handled).has(testnetSecond)).toBe(false);

      pipeline.release(testnetFirst);
      await harness.scheduler.pollOnce();
      await flushDispatch();
      expect(new Set(pipeline.handled).has(testnetSecond)).toBe(true);

      pipeline.release(testnetSecond);
    } finally {
      await harness.cleanup();
    }
  });

  it("unset SCVS_WORKER_CONCURRENCY_TESTNET admits testnet up to the global cap, unchanged", async () => {
    process.env.SCVS_WORKER_CONCURRENCY = "2";
    delete process.env.SCVS_WORKER_CONCURRENCY_TESTNET;
    const pipeline = new HoldingPipeline();
    const harness = await buildSchedulerHarness(pipeline);

    try {
      const first = await harness.createJob("testnet");
      const second = await harness.createJob("testnet");

      await harness.scheduler.pollOnce();
      await flushDispatch();

      const handled = new Set(pipeline.handled);
      expect(handled.has(first)).toBe(true);
      expect(handled.has(second)).toBe(true);
      pipeline.release(first);
      pipeline.release(second);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not apply the testnet ceiling to mainnet jobs", async () => {
    process.env.SCVS_WORKER_CONCURRENCY = "2";
    process.env.SCVS_WORKER_CONCURRENCY_TESTNET = "0";
    const pipeline = new HoldingPipeline();
    const harness = await buildSchedulerHarness(pipeline);

    try {
      const first = await harness.createJob("mainnet");
      const second = await harness.createJob("mainnet");

      await harness.scheduler.pollOnce();
      await flushDispatch();

      const handled = new Set(pipeline.handled);
      expect(handled.has(first)).toBe(true);
      expect(handled.has(second)).toBe(true);
      pipeline.release(first);
      pipeline.release(second);
    } finally {
      await harness.cleanup();
    }
  });

  it("SCVS_WORKER_CONCURRENCY_TESTNET=0 admits no testnet jobs and does not error", async () => {
    process.env.SCVS_WORKER_CONCURRENCY = "2";
    process.env.SCVS_WORKER_CONCURRENCY_TESTNET = "0";
    const pipeline = new HoldingPipeline();
    const harness = await buildSchedulerHarness(pipeline);

    try {
      const first = await harness.createJob("testnet");
      const second = await harness.createJob("testnet");

      await expect(harness.scheduler.pollOnce()).resolves.toBeUndefined();
      await flushDispatch();

      expect(pipeline.handled).toHaveLength(0);
      expect(pipeline.handled).not.toContain(first);
      expect(pipeline.handled).not.toContain(second);
    } finally {
      await harness.cleanup();
    }
  });
});
