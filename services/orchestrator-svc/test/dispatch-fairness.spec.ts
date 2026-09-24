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

/**
 * At the default `SCVS_WORKER_CONCURRENCY=1` the oldest non-terminal job took the only slot *every* tick and no
 * newer job advanced a single step until it terminated.
 */
class RecordingPipeline {
  readonly handled: string[] = [];
  async run(job: JobRecord): Promise<void> {
    this.handled.push(job.jobId);
  }
}

/**
 * Holds a slot until deliberately released, unlike `RecordingPipeline` (which resolves immediately, freeing its
 * slot before the next tick).
 */
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

/** `StartupRecoveryService`'s real onModuleInit would reach for AWS Batch; it is not under test. */
class NoopStartupRecovery {
  async onModuleInit(): Promise<void> {}
}

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;

/**
 * Lets the fire-and-forget dispatch in `pollOnce` settle. The loop starts a job without awaiting it and frees
 * its concurrency slot in a `.finally`, so the slot is only observably free one macrotask later.
 */
function flushDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * One `BuildDispatchScheduler` wired to a real `JobsRepository`/Postgres, a substituted pipeline, and a
 * `listJobsByStatus` narrowed to rows this harness's own `createJob` calls created.
 */
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
      // The schedulers register their intervals through `SchedulerRegistry` now, so the harness needs
      // the module that provides it.
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
      // The scheduler now honours the drain (it stops claiming while draining) and records what it last saw for
      // `/health/ready`.
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

  /** The rows the dispatch loop is allowed to see, which bounds a full rotation at the jobs a case creates. */
  const visible = new Set<string>();

  // Hide rows this suite does not own from the dispatch loop, without hiding them from Postgres: the real query
  // still runs, against the real shared table, and the rotation still receives a `JobRecord[]` in oldest-first
  // creation order.
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

  // Only rows this suite created.
  async function cleanup(): Promise<void> {
    try {
      await createdRows.cleanup(prisma);
    } finally {
      // Closing waits for every dispatched step, so a case that failed before releasing its jobs must not hang it.
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
    // `harness` is unset when `beforeAll` threw; cleaning up then would bury the real error under a TypeError.
    if (harness) await harness.cleanup();
  });

  it("gives every active job a turn instead of replaying the oldest one every tick", async () => {
    // Three jobs, created oldest-first — the shape that starved. `SCVS_WORKER_CONCURRENCY` is unset in the test
    // environment, so `clampConcurrency` yields 1: exactly the production default.
    const first = await harness.createJob("testnet");
    const second = await harness.createJob("testnet");
    const third = await harness.createJob("testnet");

    // One full rotation — the cursor advances one job per tick, so three ticks is exactly enough for all three
    // to be served once, and no more than enough.
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

    // Concurrency is 1, so one tick may only start one job — fairness rotates *across* ticks, it does not widen
    // the cap.
    expect(pipeline.handled).toHaveLength(1);
  });
});

/**
 * `configuration()` reads `SCVS_WORKER_CONCURRENCY`/`SCVS_WORKER_CONCURRENCY_TESTNET` from `process.env` once,
 * at `ConfigModule.forRoot`'s compile time.
 */
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
      // Global concurrency is 2, testnet's ceiling is 1.
      const testnetFirst = await harness.createJob("testnet");
      const testnetSecond = await harness.createJob("testnet");
      const mainnetJob = await harness.createJob("mainnet");

      // Tick 1: rotation starts at index 0 (testnetFirst).
      await harness.scheduler.pollOnce();
      await flushDispatch();

      const handledAfterTick1 = new Set(pipeline.handled);
      expect(handledAfterTick1.has(testnetFirst)).toBe(true);
      expect(handledAfterTick1.has(mainnetJob)).toBe(true);
      expect(handledAfterTick1.has(testnetSecond)).toBe(false);

      // Tick 2: both global slots are still held (neither job has been released), so the whole tick
      // short-circuits on the global cap before the per-network check is ever reached. testnetSecond still
      // cannot get in.
      await harness.scheduler.pollOnce();
      await flushDispatch();
      expect(new Set(pipeline.handled).has(testnetSecond)).toBe(false);

      // Release the mainnet job's slot and let a further tick run: the freed slot is global, not
      // network-scoped, so testnetSecond is now free to take it.
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
    // Two testnet jobs against a global cap of 2 is the part that actually exercises "unchanged".
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
    // The per-network check in build-dispatch.scheduler.ts guards on `job.target.network === "testnet"` — this
    // case fails if that guard is ever widened to cover every network.
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
    // The global cap is never the binding constraint here — the per-network check must reject both jobs before
    // it.
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
