import type { EnvironmentRecord, EnvironmentsRepository } from "@scvs/db";
import type { ConfigService } from "@nestjs/config";
import { EnvironmentReconcilerScheduler } from "../src/modules/scheduler/environment-reconciler.scheduler.js";
import type { ComposerDispatchService } from "../src/modules/build-environments/composer-dispatch.service.js";
import type { EnvironmentOutcomeService } from "../src/modules/build-environments/environment-outcome.service.js";
import type { AppConfigService } from "../src/config/configuration.js";

const TIMEOUT_MS = 45 * 60_000;

function stuck(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    environmentId: "env-1",
    cliver: "25.1.0",
    rsver: "1.95.0",
    templateVersion: "v1",
    status: "composing",
    batchJobId: "batch-1",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

class FakeEnvironments {
  released: string[] = [];
  listArgs: Array<{ status: string; olderThan: Date }> = [];
  constructor(private readonly rows: EnvironmentRecord[] = []) {}
  async listStuckByStatus(status: string, olderThan: Date): Promise<EnvironmentRecord[]> {
    this.listArgs.push({ status, olderThan });
    return this.rows;
  }
  async releaseClaim(environmentId: string): Promise<void> {
    this.released.push(environmentId);
  }
}

class FakeComposer {
  describeCalls = 0;
  constructor(
    private readonly answer: { status: string; statusReason?: string } | undefined | Error,
  ) {}
  async describeBatchJob(): Promise<{ status: string; statusReason?: string } | undefined> {
    this.describeCalls += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

class FakeOutcomes {
  fromBatch: Array<{ status: string }> = [];
  fromArtifact = 0;
  constructor(private readonly artifactPresent = false) {}
  async recordFromBatchTerminalState(
    _environment: EnvironmentRecord,
    event: { status: string },
  ): Promise<{ status: "failed"; errorCode: string }> {
    this.fromBatch.push(event);
    return { status: "failed", errorCode: "recorded" };
  }
  async tryRecordFromArtifact(): Promise<boolean> {
    this.fromArtifact += 1;
    return this.artifactPresent;
  }
}

const config = {
  get: () => TIMEOUT_MS,
} as unknown as AppConfigService & ConfigService;

function schedulerFor(
  environments: FakeEnvironments,
  composer: FakeComposer,
  outcomes: FakeOutcomes,
): EnvironmentReconcilerScheduler {
  return new EnvironmentReconcilerScheduler(
    config,
    environments as unknown as EnvironmentsRepository,
    composer as unknown as ComposerDispatchService,
    outcomes as unknown as EnvironmentOutcomeService,
  );
}

describe("EnvironmentReconcilerScheduler", () => {
  it("scans only composing rows, and only ones older than the configured timeout", async () => {
    const environments = new FakeEnvironments([]);
    await schedulerFor(environments, new FakeComposer(undefined), new FakeOutcomes()).
      reconcileStuckEnvironments();

    expect(environments.listArgs).toHaveLength(1);
    expect(environments.listArgs[0]!.status).toBe("composing");
    expect(Date.now() - environments.listArgs[0]!.olderThan.getTime()).toBeGreaterThanOrEqual(
      TIMEOUT_MS,
    );
  });

  it("resets a claimed row that never recorded a Batch job id", async () => {
    const environments = new FakeEnvironments([stuck({ batchJobId: undefined })]);
    const composer = new FakeComposer(undefined);

    await schedulerFor(environments, composer, new FakeOutcomes()).reconcileStuckEnvironments();

    expect(environments.released).toEqual(["env-1"]);
    expect(composer.describeCalls).toBe(0);
  });

  it("leaves a row alone while Batch still reports it non-terminal", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes();

    await schedulerFor(environments, new FakeComposer({ status: "RUNNING" }), outcomes).
      reconcileStuckEnvironments();

    expect(environments.released).toEqual([]);
    expect(outcomes.fromBatch).toEqual([]);
    expect(outcomes.fromArtifact).toBe(0);
  });

  it("resolves from the receipt when Batch reports terminal but the event never arrived", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes();

    await schedulerFor(
      environments,
      new FakeComposer({ status: "FAILED", statusReason: "OutOfMemoryError" }),
      outcomes,
    ).reconcileStuckEnvironments();

    expect(outcomes.fromBatch).toEqual([{ status: "FAILED", statusReason: "OutOfMemoryError" }]);
    expect(environments.released).toEqual([]);
  });

  it("falls to the receipt when Batch has forgotten the job entirely", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes(true);

    await schedulerFor(environments, new FakeComposer(undefined), outcomes).
      reconcileStuckEnvironments();

    expect(outcomes.fromArtifact).toBe(1);
    expect(environments.released).toEqual([]);
  });

  it("resets to pending — never to failed — when there is no Batch record and no receipt", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes(false);

    await schedulerFor(environments, new FakeComposer(undefined), outcomes).
      reconcileStuckEnvironments();

    expect(environments.released).toEqual(["env-1"]);
    expect(outcomes.fromBatch).toEqual([]);
  });

  it("forfeits the reset when Batch could not be asked at all", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes(false);

    await schedulerFor(
      environments,
      new FakeComposer(new Error("AccessDeniedException: batch:DescribeJobs")),
      outcomes,
    ).reconcileStuckEnvironments();

    expect(outcomes.fromArtifact).toBe(1);
    expect(environments.released).toEqual([]);
  });

  it("still resolves from the receipt when Batch is unreachable but the receipt is there", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes(true);

    await schedulerFor(
      environments,
      new FakeComposer(new Error("network unreachable")),
      outcomes,
    ).reconcileStuckEnvironments();

    expect(outcomes.fromArtifact).toBe(1);
    expect(environments.released).toEqual([]);
  });

  it("treats a Batch status outside both vocabularies as unknown, not as terminal", async () => {
    const environments = new FakeEnvironments([stuck()]);
    const outcomes = new FakeOutcomes(false);

    await schedulerFor(environments, new FakeComposer({ status: "SOMETHING_NEW" }), outcomes).
      reconcileStuckEnvironments();

    expect(outcomes.fromBatch).toEqual([]);
    expect(outcomes.fromArtifact).toBe(1);
    expect(environments.released).toEqual(["env-1"]);
  });

  it("keeps scanning after one row throws, so a single bad row cannot wedge the sweep", async () => {
    const rows = [stuck({ environmentId: "env-1" }), stuck({ environmentId: "env-2" })];
    const environments = new FakeEnvironments(rows);
    let call = 0;
    const composer = {
      async describeBatchJob() {
        call += 1;
        if (call === 1) throw new Error("transient");
        return undefined;
      },
    };
    const outcomes = new FakeOutcomes(false);

    await schedulerFor(
      environments,
      composer as unknown as FakeComposer,
      outcomes,
    ).reconcileStuckEnvironments();

    expect(environments.released).toEqual(["env-2"]);
  });

  it("does not run two overlapping scans", async () => {
    let resolveList: (rows: EnvironmentRecord[]) => void = () => {};
    const environments = {
      listArgs: [] as unknown[],
      calls: 0,
      async listStuckByStatus(): Promise<EnvironmentRecord[]> {
        this.calls += 1;
        return new Promise((resolve) => {
          resolveList = resolve;
        });
      },
      async releaseClaim(): Promise<void> {},
    };
    const scheduler = schedulerFor(
      environments as unknown as FakeEnvironments,
      new FakeComposer(undefined),
      new FakeOutcomes(),
    );

    const first = scheduler.reconcileStuckEnvironments();
    await scheduler.reconcileStuckEnvironments();
    resolveList([]);
    await first;

    expect(environments.calls).toBe(1);
  });
});
