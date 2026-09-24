import { jest } from "@jest/globals";
import { isRetryableFailure } from "@scvs/core";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
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
  UploadJobReferencesRepository,
  UploadsRepository,
  type JobRecord,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { RebuildReconcilerScheduler } from "../src/modules/scheduler/rebuild-reconciler.scheduler.js";
import { RebuildOutcomeService } from "../src/modules/batch-events/rebuild-outcome.service.js";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { ChainReaderService } from "../src/modules/verification-pipeline/chain-reader.service.js";
import { BatchDispatchService } from "../src/modules/verification-pipeline/batch-dispatch.service.js";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";
import { MismatchDiagnosticsService } from "../src/modules/verification-pipeline/mismatch-diagnostics.service.js";
import { VerificationPipelineService } from "../src/modules/verification-pipeline/verification-pipeline.service.js";
import { PublishService } from "../src/modules/publish/publish.service.js";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import { BuildEnvironmentIdentityService } from "../src/modules/verification-pipeline/build-environment-identity.service.js";
import { BuildEnvironmentResolver } from "../src/modules/build-environments/build-environment-resolver.js";
import { BuildEnvironmentMaterializer } from "../src/modules/build-environments/build-environment-materializer.js";
import { DeterministicBuildEnvironmentResolver } from "../src/modules/build-environments/deterministic-build-environment-resolver.service.js";

/**
 * Three external systems are substituted, and only those: `ChainReaderService` — a stub, so a target's
 * currently-deployed hash can be changed *mid-test*.
 */
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;
const REBUILT_HASH = "1".repeat(64);
const OTHER_HASH = "2".repeat(64);
/**
 * The publish path fetches this for `sources/`, and cases below assert that the fetch does not succeed. A
 * resolvable host would put a live request inside every publishing case's timeout; `localhost` is refused by
 * the destination policy itself, before a socket is opened.
 */
const SUBMITTED_SOURCE_URI = "https://localhost/e2e.tar.gz";

/** Stands in for the chain: per-contract deployed hashes, mutable so a test can "upgrade" one. */
class StubChainReader {
  readonly deployed = new Map<string, string>();
  readonly replay = new Map<string, string[]>();
  readonly failing = new Set<string>();
  /** Targets whose chain metadata records neither a `bldimg` nor a toolchain pair. */
  readonly cliNone = new Set<string>();
  /**
   * The build recipe the contract's own metadata section records, when a case needs it to differ from what the
   * job asks to build.
   */
  readonly recordedRecipe = new Map<string, { bldarg?: string[]; bldopt?: string[] }>();

  async getWasmMetadata(target: { contract_id?: string; wasm_hash?: string }) {
    const key = target.contract_id ?? target.wasm_hash ?? "";
    if (this.failing.has(key)) {
      return {
        ok: false as const,
        status: "chain_lookup_failed" as const,
        reason: "stellar_contract_fetch_failed",
        detail: "stub: chain unavailable",
        diagnostics: {},
      };
    }
    const hash = this.deployed.get(key);
    if (!hash) {
      return {
        ok: false as const,
        status: "not_found" as const,
        reason: "stellar_contract_fetch_failed",
        detail: "stub: unknown target",
        diagnostics: {},
      };
    }
    if (this.cliNone.has(key)) {
      return {
        ok: true as const,
        metadata: {
          wasm_hash: hash,
          wasm_byte_size: 1024,
          sep58: { raw_entries: [] },
          diagnostics: { mode: "stellar_cli" as const, fetch: {} as never },
        },
      };
    }
    return {
      ok: true as const,
      metadata: {
        wasm_hash: hash,
        wasm_byte_size: 1024,
        // The fixture already asserted this about itself: the `metadata_replay` entries these tests build
        // contain `bldimg=<IMAGE>`, and `dropped_keys` names `cliver`.
        sep58: { bldimg: IMAGE, raw_entries: [], ...(this.recordedRecipe.get(key) ?? {}) },
        ...(this.replay.has(key)
          ? {
              metadata_replay: {
                section_index: 0,
                entries: this.replay.get(key)!,
                dropped_keys: ["cliver"],
              },
            }
          : {}),
        diagnostics: { mode: "stellar_cli" as const, fetch: {} as never },
      },
    };
  }
}

/** Records dispatches instead of talking to AWS Batch; still drives the real state transition. */
class StubBatchDispatch {
  readonly submissions: {
    rebuildId: string;
    mode: string;
    pinnedHash?: string;
    buildOptions?: string[];
    buildArgs?: string[];
    metadataReplay?: string[];
  }[] = [];
  /**
   * What AWS Batch would answer for a given job id. Absent = Batch has no record of it, which is a real answer
   * (job records are only retained for a bounded window) and the one the reconciler must NOT read as "failed".
   */
  readonly batchState = new Map<string, { status: string; statusReason?: string }>();
  /** Job ids `DescribeJobs` cannot be asked about at all — an IAM denial, throttling, expired credentials. */
  readonly describeThrowsFor = new Set<string>();
  readonly described: string[] = [];
  failNextSubmissions = 0;
  constructor(private readonly rebuilds: RebuildsRepository) {}

  async describeBatchJob(
    batchJobId: string
  ): Promise<{ status: string; statusReason?: string } | undefined> {
    this.described.push(batchJobId);
    if (this.describeThrowsFor.has(batchJobId)) {
      throw new Error(
        "stub: AccessDeniedException — not authorized to perform: batch:DescribeJobs"
      );
    }
    return this.batchState.get(batchJobId);
  }

  async submitBatchJob(
    params: {
      rebuildId: string;
      target: { wasm_hash?: string };
      buildOptions?: string[];
      buildArgs?: string[];
      metadataReplay?: string[];
    },
    mode: string
  ): Promise<string> {
    if (this.failNextSubmissions > 0) {
      this.failNextSubmissions -= 1;
      throw new Error(
        "stub: Batch SubmitJob rejected — Container Overrides length must be at most 8192 bytes"
      );
    }
    this.submissions.push({
      rebuildId: params.rebuildId,
      mode,
      pinnedHash: params.target.wasm_hash,
      buildOptions: params.buildOptions,
      buildArgs: params.buildArgs,
      metadataReplay: params.metadataReplay,
    });
    const batchJobId = `stub-batch-${randomUUID()}`;
    await this.rebuilds.markDispatched(params.rebuildId, {
      batchJobId,
      buildMode: mode as "verify" | "build",
    });
    return batchJobId;
  }
}

/** Records whether a mismatch was explained, and returns nothing. */
class StubMismatchDiagnostics {
  readonly calls: { rebuildId: string; buildMode: string }[] = [];

  async describe(input: { rebuildId: string; buildMode: string }): Promise<undefined> {
    this.calls.push({ rebuildId: input.rebuildId, buildMode: input.buildMode });
    return undefined;
  }
}

/** Stands in for the S3 read only. */
class StubRebuildOutcomes {
  artifact: {
    outcome: "success" | "comparison_mismatch" | "cli_failure";
    runner?: string;
    rebuiltWasmHash?: string;
    errorCode?: string;
  } | null = null;
  readonly calls: { via: "batch-terminal" | "artifact-only"; rebuildId: string }[] = [];

  constructor(private readonly rebuilds: RebuildsRepository) {}

  async recordFromBatchTerminalState(
    rebuild: { rebuildId: string },
    event: { status: string; statusReason?: string }
  ) {
    this.calls.push({ via: "batch-terminal", rebuildId: rebuild.rebuildId });
    // Mirrors the real service: artifact if there is one, else synthesise from the Batch event.
    const outcome =
      this.artifact ??
      ({
        outcome: "cli_failure" as const,
        errorCode: "batch_job_failed_no_artifact",
      } satisfies { outcome: "cli_failure"; errorCode: string });
    await this.rebuilds.markTerminal(rebuild.rebuildId, outcome);
    return { ...outcome, exitCode: event.status === "SUCCEEDED" ? 0 : null };
  }

  async tryRecordFromArtifact(rebuild: { rebuildId: string }): Promise<boolean> {
    this.calls.push({ via: "artifact-only", rebuildId: rebuild.rebuildId });
    if (!this.artifact) return false;
    await this.rebuilds.markTerminal(rebuild.rebuildId, this.artifact);
    return true;
  }
}

/**
 * Every target in this suite is **cli-58**: `bldimg` is present in the chain-injected metadata, so
 * `resolveEnvironmentIdentity()` returns the policy-checked image before the resolver or materializer is ever
 * consulted.
 */
class UnreachableMaterializer {
  async materialize(): Promise<never> {
    throw new Error(
      "pipeline-e2e: materialize() was called, but every target in this suite is cli-58 (bldimg " +
        "present), so composition must never be reached. See UnreachableMaterializer's comment.",
    );
  }
  async findReadyByRecipeSha256(): Promise<never> {
    throw new Error(
      "pipeline-e2e: findReadyByRecipeSha256() was called, which means a rebuild was keyed on a " +
        "recipe hash rather than a chain-named image. See UnreachableMaterializer's comment.",
    );
  }
}

/**
 * Every outbound request `SourceResolutionService` can make, substituted in one place. `deleteStagedUpload` is
 * deliberately not one of them: cases here assert on that call, so only the S3 delete under it is replaced.
 */
function substituteOutboundRequests(service: SourceResolutionService): void {
  const internals = service as unknown as {
    stageRemoteSource: (ref: unknown) => Promise<{ ok: true; sourceRef: unknown }>;
    presignUploadGet: () => Promise<string>;
    deleteStagedObject: () => Promise<void>;
  };
  jest.spyOn(internals, "stageRemoteSource").mockImplementation(async (ref: unknown) => ({
    ok: true,
    sourceRef: { ...(ref as object), source_uri: "https://staging.test/fetched-source?sig=stub" },
  }));
  jest.spyOn(internals, "presignUploadGet").mockResolvedValue("https://staging.test/staged-upload?sig=stub");
  jest.spyOn(internals, "deleteStagedObject").mockResolvedValue(undefined);
  // Neither read has a case in this suite — no job is public *and* uploaded, and no rebuild records a canonical
  // source — so a throw keeps it that way instead of letting a later case publish nothing and stay green.
  jest
    .spyOn(service, "readStagedUploadBytes")
    .mockRejectedValue(new Error("pipeline-e2e: readStagedUploadBytes() was called; see substituteOutboundRequests()."));
  jest
    .spyOn(service, "readStagingObjectBytes")
    .mockRejectedValue(new Error("pipeline-e2e: readStagingObjectBytes() was called; see substituteOutboundRequests()."));
}

let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let uploads: UploadsRepository;
let uploadJobReferences: UploadJobReferencesRepository;
let pipeline: VerificationPipelineService;
let reconciler: RebuildReconcilerScheduler;
let publish: PublishService;
let sourceResolution: SourceResolutionService;
let prisma: PrismaClient;
let chain: StubChainReader;
let batch: StubBatchDispatch;
let outcomes: StubRebuildOutcomes;
let mismatchDiagnostics: StubMismatchDiagnostics;
let resultRoot: string;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

beforeAll(async () => {
  // A per-run result tree, so publishing is genuinely exercised without depending on (or polluting) the fixture
  // path the other suites use.
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-e2e-results-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4999";
  process.env.SCVS_ARWEAVE_MODE = "disabled";

  chain = new StubChainReader();

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      // The schedulers register their intervals through `SchedulerRegistry` now, so the harness
      // needs the module that provides it.
      ScheduleModule.forRoot(),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) =>
          configService.get("postgres", { infer: true }),
      }),
    ],
    providers: [
      SourceResolutionService,
      ArweaveArchiveService,
      PublishService,
      VerificationPipelineService,
      BuildEnvironmentIdentityService,
      RebuildReconcilerScheduler,
      { provide: ChainReaderService, useValue: chain },
      {
        provide: RebuildOutcomeService,
        useFactory: (r: RebuildsRepository) => new StubRebuildOutcomes(r),
        inject: [RebuildsRepository],
      },
      {
        provide: BatchDispatchService,
        useFactory: (r: RebuildsRepository) => new StubBatchDispatch(r),
        inject: [RebuildsRepository],
      },
      // The **resolver is the real one**: it is pure — no network, no database, no submitter-reachable input —
      // so substituting it would only weaken the suite.
      { provide: BuildEnvironmentResolver, useClass: DeterministicBuildEnvironmentResolver },
      { provide: BuildEnvironmentMaterializer, useValue: new UnreachableMaterializer() },
      { provide: MismatchDiagnosticsService, useValue: new StubMismatchDiagnostics() },
    ],
  }).compile();

  jobs = moduleRef.get(JobsRepository);
  rebuilds = moduleRef.get(RebuildsRepository);
  uploads = moduleRef.get(UploadsRepository);
  uploadJobReferences = moduleRef.get(UploadJobReferencesRepository);
  pipeline = moduleRef.get(VerificationPipelineService);
  reconciler = moduleRef.get(RebuildReconcilerScheduler);
  publish = moduleRef.get(PublishService);
  sourceResolution = moduleRef.get(SourceResolutionService);
  substituteOutboundRequests(sourceResolution);
  prisma = moduleRef.get(PRISMA_CLIENT);
  batch = moduleRef.get(BatchDispatchService) as unknown as StubBatchDispatch;
  outcomes = moduleRef.get(RebuildOutcomeService) as unknown as StubRebuildOutcomes;
  mismatchDiagnostics = moduleRef.get(
    MismatchDiagnosticsService
  ) as unknown as StubMismatchDiagnostics;
});

// A suite removes what it created, and only what it created. The rebuilds are not tracked by hand.
afterAll(async () => {
  // `prisma` is unset when `beforeAll` threw; cleaning up then would bury the real error under a TypeError.
  try {
    // Scheduled archives write to the rows cleanup deletes, so they finish first.
    if (moduleRef) await moduleRef.get(ArweaveArchiveService).onModuleDestroy();
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

/** Backdates a rebuild's `updated_at` so the reconciler sees it as silent. */
/** Runs `body` with result-storage construction forced to fail. */
async function withBrokenPublishing(body: () => Promise<void>): Promise<void> {
  const internals = publish as unknown as { buildResultStorage: () => unknown };
  const real = internals.buildResultStorage;
  internals.buildResultStorage = () => {
    throw new Error("stub: result storage unavailable");
  };
  try {
    await body();
  } finally {
    internals.buildResultStorage = real;
  }
}

async function backdateRebuild(rebuildId: string, ageMs: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE rebuilds SET updated_at = now() - ($1 || ' milliseconds')::interval WHERE id = $2::uuid`,
    String(ageMs),
    rebuildId,
  );
}

/** One submission's worth of rows, as verification-svc would have written them. */
async function createJob(options: {
  contractId?: string;
  wasmHash?: string;
  sourceSha256: string;
  dryRun?: boolean;
  network?: "testnet" | "mainnet";
}): Promise<JobRecord> {
  const jobId = createdRows.job(randomUUID());
  await jobs.createJob({
    dryRun: options.dryRun ?? false,
    jobId,
    target: {
      network: options.network ?? "testnet",
      ...(options.contractId ? { contract_id: options.contractId } : {}),
      ...(options.wasmHash ? { wasm_hash: options.wasmHash } : {}),
    },
    verificationMode: "submitted",
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: SUBMITTED_SOURCE_URI,
      source_sha256: options.sourceSha256,
    },
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      bldimg: IMAGE,
      source_sha256: options.sourceSha256,
      source_uri: SUBMITTED_SOURCE_URI,
    } as never,
  });
  return (await jobs.getJobById(jobId))!;
}

const contractId = () => `C${randomBytes(20).toString("hex").toUpperCase()}`;
const reload = async (jobId: string) => (await jobs.getJobById(jobId))!;

describe("ADR-008 pipeline, end to end", () => {
  // The two reconciliation stubs carry per-test state; reset it so one case's "Batch says SUCCEEDED" or "the
  // builder uploaded an artifact" cannot leak into the next.
  beforeEach(() => {
    outcomes.artifact = null;
    outcomes.calls.length = 0;
    batch.batchState.clear();
    batch.describeThrowsFor.clear();
    batch.described.length = 0;
    chain.replay.clear();
  });

  it("shares one rebuild across two targets and gives each its own independently-computed verdict", async () => {
    // Two different contracts, byte-identical build recipe. Under the old model these collided on one row via
    // the UNIQUE idempotency_key and the second inherited the first's verdict.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    // A deploys exactly what the rebuild will produce; B deploys something else.
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, OTHER_HASH);
    const explainedBefore = mismatchDiagnostics.calls.length;

    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    const jobB = await createJob({ contractId: contractB, sourceSha256 });

    // --- tick 1: both attach; exactly one wins the dispatch claim -----------------------------
    await pipeline.run(jobA);
    await pipeline.run(jobB);

    const attachedA = await reload(jobA.jobId);
    const attachedB = await reload(jobB.jobId);
    expect(attachedA.rebuildId).toBeDefined();
    expect(attachedB.rebuildId).toBe(attachedA.rebuildId);
    expect(batch.submissions.filter((s) => s.rebuildId === attachedA.rebuildId)).toHaveLength(1);
    // Whoever dispatched pinned its own target's hash for `stellar contract verify`.
    expect([REBUILT_HASH, OTHER_HASH]).toContain(
      batch.submissions.find((s) => s.rebuildId === attachedA.rebuildId)!.pinnedHash
    );

    // --- the Batch job finishes: the rebuild records its bytes, nothing more ------------------
    await rebuilds.markTerminal(attachedA.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });

    // --- tick 2: each job resolves its own verdict against its own deployed hash --------------
    await pipeline.run(attachedA);
    await pipeline.run(attachedB);

    const finalA = await reload(jobA.jobId);
    const finalB = await reload(jobB.jobId);

    expect(finalA.status).toBe("published");
    expect(finalA.result?.matched).toBe(true);
    expect(finalA.result?.status_summary).toBe("verified");

    // Both outcomes are `published`; which one it was lives in `verdict`, and `failure_reason` stays null
    // because nothing failed — the comparison ran and answered.
    expect({
      status: finalB.status,
      verdict: finalB.verdict,
      failureReason: finalB.failureReason,
      error: finalB.error,
      progress: finalB.progress,
      rebuildStatus: (await rebuilds.getById(attachedA.rebuildId!))?.status,
      rebuildOutcome: (await rebuilds.getById(attachedA.rebuildId!))?.outcome,
      rebuiltHash: (await rebuilds.getById(attachedA.rebuildId!))?.rebuiltWasmHash,
    }).toMatchObject({ status: "published" });
    expect(finalB.verdict).toBe("mismatched");
    expect(finalB.failureReason).toBeNull();
    expect(finalB.result?.matched).toBe(false);
    expect(finalB.result?.status_summary).toBe("mismatch");
    expect(finalA.verdict).toBe("verified");

    // One rebuild, one dispatch, two published artifacts.
    expect(finalA.result?.artifact_sha256).toBeDefined();
    expect(finalB.result?.artifact_sha256).toBeDefined();
    expect(finalA.result?.artifact_sha256).not.toBe(finalB.result?.artifact_sha256);

    // Only the mismatching job asks why. Both share one rebuild, so the *count* is what distinguishes them —
    // and it is also what proves the matched job pays nothing for the diagnostic path.
    expect(mismatchDiagnostics.calls).toHaveLength(explainedBefore + 1);
    expect(mismatchDiagnostics.calls.at(-1)).toEqual({
      rebuildId: attachedA.rebuildId,
      buildMode: "build",
    });
    // And an unavailable explanation does not hold up, or alter, the mismatch verdict itself.
    expect(finalB.result?.status_summary).toBe("mismatch");

    // The row must record a retry obligation, not silently drop it: sourcePublishPendingSince set,
    // sourceFileName still absent, one attempt recorded.
    expect(finalB.sourcePublishPendingSince).toBeDefined();
    expect(finalB.sourceFileName).toBeUndefined();
    expect(finalB.sourcePublishAttempts).toBe(1);
    // And jobA (matched, same failure mode on the same unreachable URL) gets the identical treatment — this is
    // gated on visibility/durability, not on the verdict.
    expect(finalA.sourcePublishPendingSince).toBeDefined();
    expect(finalA.sourceFileName).toBeUndefined();
    expect(finalA.sourcePublishAttempts).toBe(1);
  });

  it("scopes rebuild identity and published recipe by chain-derived metadata_replay", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    const replayA = ["bldimg=" + IMAGE, "source_sha256=" + sourceSha256, "home_domain=a.example"];
    const replayB = ["bldimg=" + IMAGE, "source_sha256=" + sourceSha256, "home_domain=b.example"];
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, REBUILT_HASH);
    chain.replay.set(contractA, replayA);
    chain.replay.set(contractB, replayB);

    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    const jobB = await createJob({ contractId: contractB, sourceSha256 });

    await pipeline.run(jobA);
    await pipeline.run(jobB);

    const attachedA = await reload(jobA.jobId);
    const attachedB = await reload(jobB.jobId);
    expect(attachedA.rebuildId).toBeDefined();
    expect(attachedB.rebuildId).toBeDefined();
    expect(attachedA.rebuildId).not.toBe(attachedB.rebuildId);
    expect((attachedA.buildOptions as { metadata_replay?: string[] }).metadata_replay).toEqual(replayA);
    expect((attachedB.buildOptions as { metadata_replay?: string[] }).metadata_replay).toEqual(replayB);
    expect(batch.submissions.find((s) => s.rebuildId === attachedA.rebuildId)?.metadataReplay).toEqual(replayA);
    expect(batch.submissions.find((s) => s.rebuildId === attachedB.rebuildId)?.metadataReplay).toEqual(replayB);

    await rebuilds.markTerminal(attachedA.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await rebuilds.markTerminal(attachedB.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(attachedA);
    await pipeline.run(attachedB);

    const finalA = await reload(jobA.jobId);
    const finalB = await reload(jobB.jobId);
    const artifactA = JSON.parse(
      await readFile(join(resultRoot, "reports", `${finalA.result?.artifact_sha256}.json`), "utf8"),
    );
    const artifactB = JSON.parse(
      await readFile(join(resultRoot, "reports", `${finalB.result?.artifact_sha256}.json`), "utf8"),
    );
    expect(artifactA.build_recipe.build_options.metadata_replay).toEqual(replayA);
    expect(artifactB.build_recipe.build_options.metadata_replay).toEqual(replayB);
  });

  it("publishes wasms/<hash>.json for the verified target, ADR-007-compliant by construction", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    await rebuilds.markTerminal(attached.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(attached);

    const wasmStatus = JSON.parse(
      await readFile(join(resultRoot, "wasms", `${REBUILT_HASH}.json`), "utf8")
    );
    expect(wasmStatus.wasm_hash).toBe(REBUILT_HASH);
    expect(wasmStatus.source_code_verifications[0].status).toBe("verified");
  });

  it("publishes the byte verdict, recording contract_binding_drifted, when the contract upgrades mid-rebuild", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    // At submission the contract deploys something else...
    chain.deployed.set(contract, OTHER_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    expect(attached.target.wasm_hash).toBe(OTHER_HASH);

    await rebuilds.markTerminal(attached.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    // ...and by the time the rebuild lands, it has been upgraded to the rebuilt bytes.
    chain.deployed.set(contract, REBUILT_HASH);

    await pipeline.run(attached);
    const final = await reload(job.jobId);

    expect(final.result?.contract_binding_drifted).toBe(true);
    expect(final.result?.matched).toBe(true);
    // The verdict is about the hash actually compared against, not the stale recorded one.
    expect(final.result?.wasm_hash).toBe(REBUILT_HASH);

    const wasmStatus = JSON.parse(
      await readFile(join(resultRoot, "wasms", `${REBUILT_HASH}.json`), "utf8")
    );
    expect(wasmStatus.source_code_verifications[0].status).toBe("verified");
  });

  it("sends a recipe that deviates from the chain's straight to the sandbox, never the CLI (PA1)", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    // The contract records a build option the submission does not replay.
    chain.recordedRecipe.set(contract, { bldopt: ["--features", "production"] });

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);

    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const dispatched = batch.submissions.filter((s) => s.rebuildId === rebuildId);

    // First attempt, not a retry: the sandbox is where this recipe *starts*.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].mode).toBe("build");
    expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");
  });

  /**
   * `selectBuildMechanism` no longer returns `"verify"`, so the *first* attempt is already the sandbox and
   * there is nothing to demote to — a `cli_failure` is terminal on arrival.
   */
  it("fails every job attached to a shared rebuild on one terminal cli_failure, with no further dispatch", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, REBUILT_HASH);

    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    const jobB = await createJob({ contractId: contractB, sourceSha256 });
    await pipeline.run(jobA);
    await pipeline.run(jobB);
    const attachedA = await reload(jobA.jobId);
    const rebuildId = attachedA.rebuildId!;
    const dispatchesBefore = batch.submissions.filter((s) => s.rebuildId === rebuildId).length;

    // The sandbox is the first and only attempt now, so its failure is the terminal one.
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId).at(-1)?.mode).toBe("build");

    await rebuilds.markTerminal(rebuildId, {
      outcome: "cli_failure",
      runner: "docker_build_image_rebuild",
      errorCode: "rebuild_command_failed",
    });

    // Both jobs tick. Neither earns a retry, and neither adds a dispatch.
    await pipeline.run(attachedA);
    await pipeline.run(await reload(jobB.jobId));

    expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");
    expect((await reload(jobA.jobId)).status).toBe("failed");
    expect((await reload(jobB.jobId)).status).toBe("failed");
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId)).toHaveLength(
      dispatchesBefore
    );
  });

  it("gives a resubmission a fresh attempt after a shared rebuild permanently exhausts its retry with cli_failure", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;

    // Drive the rebuild permanently terminal.
    await rebuilds.markTerminal(rebuildId, {
      outcome: "cli_failure",
      runner: "docker_build_image_rebuild",
      errorCode: "rebuild_command_failed",
    });
    await pipeline.run(await reload(job.jobId));
    expect((await reload(job.jobId)).status).toBe("failed");
    expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");

    const dispatchesBeforeResubmit = batch.submissions.filter(
      (s) => s.rebuildId === rebuildId
    ).length;

    const resubmittedJob = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(resubmittedJob);

    const resubmittedAttached = await reload(resubmittedJob.jobId);
    expect(resubmittedAttached.rebuildId).toBe(rebuildId);

    const resetRebuild = await rebuilds.getById(rebuildId);
    expect(resetRebuild?.status).toBe("running");
    expect(resetRebuild?.outcome).toBeUndefined();
    expect(resetRebuild?.buildMode).toBe("build");

    const dispatches = batch.submissions.filter((s) => s.rebuildId === rebuildId);
    expect(dispatches).toHaveLength(dispatchesBeforeResubmit + 1);
    expect(dispatches.at(-1)?.mode).toBe("build");

    // The original job is re-opened rather than left on a verdict the new attempt is about to contradict — see
    // the dedicated "re-opens a job that failed on a rebuild" case below.
    expect((await reload(job.jobId)).status).toBe("building");
  });

  it("stops reporting 'waiting on the rebuild' once the rebuild is done, even if publishing fails", async () => {
    // When publishing threw, the job kept `progress_detail = "Waiting on the verifier sandbox rebuild."` — set
    // when it attached — despite the rebuild having finished and MATCHED.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    expect(attached.progress?.detail).toMatch(/sandbox rebuild/); // accurate while it really is building
    await rebuilds.markTerminal(attached.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });

    await withBrokenPublishing(() => pipeline.run(attached));

    const wedged = await reload(job.jobId);
    expect(wedged.status).toBe("publish_pending");
    expect(wedged.verdict).toBe("verified");
    expect(wedged.result?.matched).toBe(true);
    // Still the interim summary — only publish.service.ts settles it to "verified".
    expect(wedged.result?.status_summary).toBe("running");
    expect(wedged.progress?.step).toBe("publish_failed");
    expect(wedged.progress?.detail).not.toMatch(/sandbox rebuild/);
    expect(wedged.progress?.detail).toMatch(/attempt 1 of \d+/);
    expect(wedged.publishAttempts).toBe(1);
    // The storage error itself must NOT reach this field — it is served publicly and names buckets.
    expect(wedged.progress?.detail).not.toMatch(/stub: result storage unavailable/);

    // And the recovery path still resolves it, clearing progress on the way out.
    await publish.publishJobResult(job.jobId);
    const final = await reload(job.jobId);
    expect(final.status).toBe("published");
    expect(final.result?.status_summary).toBe("verified");
    expect(final.progress).toBeUndefined();
  });

  it("stops retrying a publish once the attempt budget is spent, and says so", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    await rebuilds.markTerminal(attached.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });

    // Park it one attempt short of the default budget (10) so a single failure exhausts it.
    await jobs.updateJob(job.jobId, { publishAttempts: 9 });

    await withBrokenPublishing(async () => {
      await pipeline.run(await reload(job.jobId));
    });

    const abandoned = await reload(job.jobId);
    expect(abandoned.publishAttempts).toBe(10);
    expect(abandoned.progress?.step).toBe("publish_abandoned");
    expect(abandoned.progress?.detail).toMatch(/will not be retried automatically/);
    // The verdict itself is untouched — the bytes really did match, and that stays recorded.
    expect(abandoned.result?.matched).toBe(true);
  });

  it("re-opens a job that failed on a rebuild which is later revived and succeeds", async () => {
    // The job that gave up when the rebuild exhausted its retries stayed permanently `build_failed`, while a
    // later job attached to the revived rebuild resolved `verified` for identical bytes.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, REBUILT_HASH);

    // --- job A burns the rebuild's whole retry budget and fails -------------------------------
    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    await pipeline.run(jobA);
    const rebuildId = (await reload(jobA.jobId)).rebuildId!;

    await rebuilds.markTerminal(rebuildId, {
      outcome: "cli_failure",
      runner: "docker_build_image_rebuild",
      errorCode: "rebuild_command_failed",
    });
    await pipeline.run(await reload(jobA.jobId));

    const failedA = await reload(jobA.jobId);
    expect(failedA.status).toBe("failed");
    expect(failedA.error).toBe("rebuild_command_failed");

    // --- a new submission of the identical recipe revives the rebuild -------------------------
    const jobB = await createJob({ contractId: contractB, sourceSha256 });
    await pipeline.run(jobB);
    expect((await reload(jobB.jobId)).rebuildId).toBe(rebuildId);

    const reopenedA = await reload(jobA.jobId);
    expect(reopenedA.status).toBe("building");
    expect(reopenedA.failureReason).toBeNull();
    expect(reopenedA.error).toBeUndefined();
    expect(reopenedA.result).toBeUndefined();

    // --- and it settles on its own evidence, not by copying job B's ---------------------------
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(await reload(jobA.jobId));
    await pipeline.run(await reload(jobB.jobId));

    for (const jobId of [jobA.jobId, jobB.jobId]) {
      const final = await reload(jobId);
      expect(final.status).toBe("published");
      expect(final.result?.status_summary).toBe("verified");
    }
  });

  it("does not re-open a job that failed for its own target's reasons", async () => {
    // The scoping guard.
    const sourceSha256 = randomBytes(32).toString("hex");
    const unresolvable = contractId();
    const other = contractId();
    chain.deployed.set(unresolvable, REBUILT_HASH);
    chain.deployed.set(other, REBUILT_HASH);

    const jobOwnFailure = await createJob({ contractId: unresolvable, sourceSha256 });
    await pipeline.run(jobOwnFailure);
    const rebuildId = (await reload(jobOwnFailure.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    // Attached, then its own target stops resolving — a per-job failure on a perfectly good rebuild.
    chain.failing.add(unresolvable);
    await pipeline.run(await reload(jobOwnFailure.jobId));
    const failed = await reload(jobOwnFailure.jobId);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("internal_error");
    expect(failed.error).toBe("stellar_contract_fetch_failed");

    // Now drive that same rebuild to a terminal cli_failure and revive it with a new submission.
    await rebuilds.markTerminal(rebuildId, { outcome: "cli_failure", errorCode: "later_failure" });
    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET build_mode = 'build' WHERE id = $1::uuid`,
      rebuildId,
    );
    const jobFresh = await createJob({ contractId: other, sourceSha256 });
    await pipeline.run(jobFresh);

    // Nothing about the retry changes this job's answer, so it is left exactly as it was.
    const stillFailed = await reload(jobOwnFailure.jobId);
    expect(stillFailed.status).toBe("failed");
    expect(stillFailed.failureReason).toBe("internal_error");
  });

  it("terminates a dry run at `evaluated` and publishes nothing (TRD §4.3, §8.1)", async () => {
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({
      contractId: contract,
      sourceSha256: randomBytes(32).toString("hex"),
      dryRun: true,
    });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    expect(batch.submissions.filter((sub) => sub.rebuildId === rebuildId)).toHaveLength(1);
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    // Spied rather than asserted on real S3/DB state because `createJob`'s sourceRef is `source_uri`.
    const deleteStagedUploadSpy = jest.spyOn(sourceResolution, "deleteStagedUpload");
    await pipeline.run(await reload(job.jobId));
    expect(deleteStagedUploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "source_uri" }),
    );
    deleteStagedUploadSpy.mockRestore();

    const evaluated = await reload(job.jobId);
    expect(evaluated.status).toBe("evaluated");
    // A real verdict, returned to the submitter — `evaluated` is terminal and is NOT a failure.
    expect(evaluated.verdict).toBe("verified");
    expect(evaluated.failureReason).toBeNull();
    expect(evaluated.result?.matched).toBe(true);
    // `resolveJobVerdict` returns `status_summary: "running"` because `publish.service.ts` normally settles it.
    expect(evaluated.result?.status_summary).toBe("verified");
    // And nothing published: no artifact, and BL1's clock never moved.
    expect(evaluated.result?.artifact_sha256).toBeUndefined();
    expect(evaluated.publishedUpdatedAt).toBeUndefined();
    // A dry run has no `verified_at` to read a finish time off; `completed_at` comes from the terminal
    // transition itself, so it is set here as on every other terminal path.
    expect(evaluated.result?.verified_at).toBeUndefined();
    expect(evaluated.completedAt).toBeDefined();
    expect(evaluated.archivePendingSince).toBeUndefined();

    // Terminal: a further tick does not resurrect it into a publication.
    await pipeline.run(evaluated);
    expect((await reload(job.jobId)).status).toBe("evaluated");
  });

  it("does not let a dry run's verdict short-circuit a later real submission (TRD §7.6)", async () => {
    // The intended workflow: dry-run to `verified`, then submit the same recipe to publish it.
    const contract = contractId();
    const sourceSha256 = randomBytes(32).toString("hex");
    chain.deployed.set(contract, REBUILT_HASH);

    const dry = await createJob({ contractId: contract, sourceSha256, dryRun: true });
    await pipeline.run(dry);
    const rebuildId = (await reload(dry.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(await reload(dry.jobId));
    expect((await reload(dry.jobId)).status).toBe("evaluated");

    const real = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(real);
    expect((await reload(real.jobId)).rebuildId).toBe(rebuildId);
    await pipeline.run(await reload(real.jobId));

    const published = await reload(real.jobId);
    expect(published.status).toBe("published");
    expect(published.result?.artifact_sha256).toBeDefined();
    expect(published.publishedUpdatedAt).toBeDefined();
  });

  it("adopts the verdict this recipe already published for these bytes (§7.6 Rules B and C)", async () => {
    // Adoption is deliberately not cross-target: the adopted `result` points at the earlier job's report, and
    // that document has its own network and contract id stamped into it, so handing it to a different target
    // would tell that submitter their contract was verified by a document naming another one.
    const sourceSha256 = randomBytes(32).toString("hex");
    const first = contractId();
    const second = first;
    chain.deployed.set(first, REBUILT_HASH);

    const jobFirst = await createJob({ contractId: first, sourceSha256 });
    await pipeline.run(jobFirst);
    const rebuildId = (await reload(jobFirst.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(await reload(jobFirst.jobId));
    const published = await reload(jobFirst.jobId);
    expect(published.status).toBe("published");
    expect(published.publishedUpdatedAt).toBeDefined();

    // A second submission for that same target, same recipe, same bytes deployed right now.
    const deleteStagedUploadSpy = jest.spyOn(sourceResolution, "deleteStagedUpload");
    const jobSecond = await createJob({ contractId: second, sourceSha256 });
    await pipeline.run(jobSecond);
    expect((await reload(jobSecond.jobId)).rebuildId).toBe(rebuildId); // Rule A: one compile
    if ((await reload(jobSecond.jobId)).status !== "published") {
      await pipeline.run(await reload(jobSecond.jobId));
    }
    expect(deleteStagedUploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "source_uri" }),
    );
    deleteStagedUploadSpy.mockRestore();

    const adopted = await reload(jobSecond.jobId);
    expect(adopted.status).toBe("published");
    expect(adopted.verdict).toBe("verified");
    expect(adopted.result?.artifact_sha256).toBe(published.result?.artifact_sha256);
    // And no publication happened for it, so BL1's clock did not move.
    expect(adopted.publishedUpdatedAt).toBeUndefined();
    // The adopted `result` is the donor's document, so its `verified_at` is the donor's instant and can precede
    // this job's `created_at`.
    expect(adopted.result?.verified_at).toBe(published.result?.verified_at);
    expect(adopted.completedAt).toBeDefined();
    expect(Date.parse(adopted.completedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(adopted.createdAt),
    );
  });

  it("does not adopt when the target's bytes have moved, or when nothing was published", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const first = contractId();
    chain.deployed.set(first, REBUILT_HASH);

    const jobFirst = await createJob({ contractId: first, sourceSha256 });
    await pipeline.run(jobFirst);
    const rebuildId = (await reload(jobFirst.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(await reload(jobFirst.jobId));
    const published = await reload(jobFirst.jobId);
    expect(published.status).toBe("published");

    // A target deploying DIFFERENT bytes shares the recipe and must NOT get that verdict — this is the case the
    // whole re-check exists for.
    const upgraded = contractId();
    chain.deployed.set(upgraded, OTHER_HASH);
    const jobUpgraded = await createJob({ contractId: upgraded, sourceSha256 });
    await pipeline.run(jobUpgraded);
    await pipeline.run(await reload(jobUpgraded.jobId));
    const mismatched = await reload(jobUpgraded.jobId);
    expect(mismatched.verdict).toBe("mismatched");
    expect(mismatched.result?.artifact_sha256).not.toBe(published.result?.artifact_sha256);

    // See the cross-network adopt test below for what this means for the job's own row vs. the linked report.
    const otherContract = contractId();
    chain.deployed.set(otherContract, REBUILT_HASH);
    const jobOther = await createJob({ contractId: otherContract, sourceSha256 });
    await pipeline.run(jobOther);
    await pipeline.run(await reload(jobOther.jobId));
    const otherFinal = await reload(jobOther.jobId);
    expect(otherFinal.status).toBe("published");
    expect(otherFinal.result?.artifact_sha256).toBe(published.result?.artifact_sha256);
    expect(otherFinal.publishedUpdatedAt).toBeUndefined();

    await prisma.$executeRawUnsafe(
      `UPDATE jobs SET published_updated_at = NULL WHERE id = $1::uuid`,
      jobFirst.jobId,
    );
    const third = contractId();
    chain.deployed.set(third, REBUILT_HASH);
    const jobThird = await createJob({ contractId: third, sourceSha256 });
    await pipeline.run(jobThird);
    await pipeline.run(await reload(jobThird.jobId));
    const notAdopted = await reload(jobThird.jobId);
    expect(notAdopted.status).toBe("published");
    // It published for itself rather than pointing at a record no reader can see.
    expect(notAdopted.publishedUpdatedAt).toBeDefined();
  });

  it("adopts a verdict across networks (TRD §7.7 — a verdict attaches to a Wasm hash, not a network)", async () => {
    // Same recipe, same bytes, deployed identically on testnet and mainnet.
    const sourceSha256 = randomBytes(32).toString("hex");
    const testnetContract = contractId();
    const mainnetContract = contractId();
    chain.deployed.set(testnetContract, REBUILT_HASH);
    chain.deployed.set(mainnetContract, REBUILT_HASH);

    const donor = await createJob({ contractId: testnetContract, sourceSha256, network: "testnet" });
    await pipeline.run(donor);
    const rebuildId = (await reload(donor.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(await reload(donor.jobId));
    const published = await reload(donor.jobId);
    expect(published.status).toBe("published");
    expect(published.target.network).toBe("testnet");

    const adopter = await createJob({ contractId: mainnetContract, sourceSha256, network: "mainnet" });
    await pipeline.run(adopter);
    expect((await reload(adopter.jobId)).rebuildId).toBe(rebuildId); // Rule A: one compile, cross-network too
    await pipeline.run(await reload(adopter.jobId));

    const adopted = await reload(adopter.jobId);
    expect(adopted.status).toBe("published");
    expect(adopted.verdict).toBe("verified");
    // The SAME artifact as the donor's — no second report minted for identical inputs.
    expect(adopted.result?.artifact_sha256).toBe(published.result?.artifact_sha256);
    expect(adopted.publishedUpdatedAt).toBeUndefined();

    // Each job's own row still reads its own target — adoption never rewrites it.
    expect(adopted.target.network).toBe("mainnet");
    expect(adopted.target.contract_id).toBe(mainnetContract);

    // The linked report itself carries no target field at all.
    const artifact = JSON.parse(
      await readFile(join(resultRoot, "reports", `${adopted.result?.artifact_sha256}.json`), "utf8"),
    );
    expect(artifact.target).toBeUndefined();
    expect(artifact.result.wasm_hash).toBe(REBUILT_HASH);
  });

  it("re-queues a retryable failure, bounded, and actually rebuilds (§7.6 Rule D)", async () => {
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256: randomBytes(32).toString("hex") });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });

    // Its own target stops resolving at compare time: `internal_error`, which IS retryable.
    chain.failing.add(contract);
    await pipeline.run(await reload(job.jobId));
    expect((await reload(job.jobId)).failureReason).toBe("internal_error");

    const eligible = new Date(Date.now() - 60 * 60_000);
    const requeued = await jobs.requeueRetryableFailures(3, eligible, [job.jobId]);
    expect(requeued).toContain(job.jobId);

    const retried = await reload(job.jobId);
    expect(retried.status).toBe("queued");
    expect(retried.retryAttempts).toBe(1);
    expect(retried.failureReason).toBeNull();
    expect(retried.result).toBeUndefined();
    expect(retried.rebuildId).toBeUndefined();

    // And it does reach a verdict once the chain comes back.
    chain.failing.delete(contract);
    await pipeline.run(retried);
    await rebuilds.markTerminal((await reload(job.jobId)).rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(await reload(job.jobId));
    expect((await reload(job.jobId)).status).toBe("published");
  });

  it("preserves a staged private upload across a retryable submission failure, so the retry rebuilds", async () => {
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const uploadId = createdRows.upload(randomUUID());
    const sourceSha256 = randomBytes(32).toString("hex");
    await uploads.createUpload({
      id: uploadId,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    await uploads.markUploadReceived(uploadId, {
      path: `staging/uploads/${uploadId}/source.tar.gz`,
      filename: "source.tar.gz",
      sizeBytes: 64,
      sourceSha256,
    });

    const jobId = createdRows.job(randomUUID());
    await jobs.createJob({
      dryRun: false,
      jobId,
      target: { network: "testnet", contract_id: contract },
      verificationMode: "submitted",
      sourceRef: {
        type: "private_tarball",
        visibility: "private",
        tarball_sha256: sourceSha256,
        source_sha256: sourceSha256,
        upload_id: uploadId,
      },
      buildOptions: { bldopt: [], bldarg: [] },
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        bldimg: IMAGE,
        source_sha256: sourceSha256,
        upload_id: uploadId,
      } as never,
    });
    await uploadJobReferences.recordReference(uploadId, jobId);

    // The submission itself is rejected — the oversized-payload shape, before any container starts.
    batch.failNextSubmissions = 1;
    const deleteStagedUploadSpy = jest.spyOn(sourceResolution, "deleteStagedUpload");
    try {
      await pipeline.run((await jobs.getJobById(jobId))!);

      const failed = await reload(jobId);
      expect(failed.status).toBe("failed");
      expect(failed.failureReason).toBe("internal_error");
      expect(deleteStagedUploadSpy).not.toHaveBeenCalled();
      expect(await uploads.getUpload(uploadId)).toBeDefined();

      const eligible = new Date(Date.now() - 60 * 60_000);
      expect(await jobs.requeueRetryableFailures(3, eligible, [jobId])).toContain(jobId);

      const submissionsBefore = batch.submissions.length;
      await pipeline.run(await reload(jobId));
      expect(batch.submissions.length).toBeGreaterThan(submissionsBefore);

      await rebuilds.markTerminal((await reload(jobId)).rebuildId!, {
        outcome: "success",
        runner: "stellar_contract_verify",
        rebuiltWasmHash: REBUILT_HASH,
      });
      await pipeline.run(await reload(jobId));
      expect((await reload(jobId)).status).toBe("published");
    } finally {
      deleteStagedUploadSpy.mockRestore();
    }
  });

  it("never re-queues a non-retryable failure, an exhausted budget, or a stale one", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const eligible = new Date(Date.now() - 60 * 60_000);

    const nonRetryable = await createJob({ contractId: contractId(), sourceSha256 });
    await jobs.advanceJob(nonRetryable.jobId, "queued", "failed", {
      failureReason: "policy_rejected",
    });

    // Retryable, but the budget is spent.
    const exhausted = await createJob({ contractId: contractId(), sourceSha256 });
    await jobs.advanceJob(exhausted.jobId, "queued", "failed", {
      failureReason: "internal_error",
      retryAttempts: 3,
    });

    // Retryable and unspent, but failed long before the eligibility window — the deploy-day backlog every
    // existing row would otherwise be part of, since they all start at retry_attempts = 0.
    const stale = await createJob({ contractId: contractId(), sourceSha256 });
    await jobs.advanceJob(stale.jobId, "queued", "failed", { failureReason: "build_timeout" });
    await prisma.$executeRawUnsafe(
      `UPDATE jobs SET updated_at = now() - interval '30 days' WHERE id = $1::uuid`,
      stale.jobId,
    );

    const mine = [nonRetryable.jobId, exhausted.jobId, stale.jobId];
    const requeued = await jobs.requeueRetryableFailures(3, eligible, mine);
    expect(requeued).not.toContain(nonRetryable.jobId);
    expect(requeued).not.toContain(exhausted.jobId);
    expect(requeued).not.toContain(stale.jobId);
    for (const id of [nonRetryable.jobId, exhausted.jobId, stale.jobId]) {
      expect((await reload(id)).status).toBe("failed");
    }

    const live = await createJob({ contractId: contractId(), sourceSha256 });
    await jobs.advanceJob(live.jobId, "queued", "failed", { failureReason: "internal_error" });
    expect(await jobs.requeueRetryableFailures(0, eligible, [live.jobId])).toEqual([]);
    expect((await reload(live.jobId)).status).toBe("failed");
  });

  it("calls a cli-none target `unsupported`, never `policy_rejected` (TRD §4.5)", async () => {
    const contract = contractId();
    const targetHash = randomBytes(32).toString("hex");
    chain.deployed.set(contract, targetHash);
    chain.cliNone.add(contract);

    const job = await createJob({ contractId: contract, sourceSha256: randomBytes(32).toString("hex") });
    await pipeline.run(job);

    const final = await reload(job.jobId);
    expect(final.status).toBe("failed");
    expect(final.failureReason).toBe("unsupported");
    expect(final.error ?? "").toMatch(/toolchain/i);
    expect(isRetryableFailure("unsupported")).toBe(false);
    await expect(
      readFile(join(resultRoot, "wasms", `${targetHash}.json`), "utf8")
    ).rejects.toThrow();
  });

  it("records the §4.5 reason the sandbox's evidence supports, not a blanket internal_error", async () => {
    // Before `rebuildFailureReason`, every non-timeout `cli_failure` was recorded as `internal_error`.
    const cases: Array<{
      errorCode: string;
      diagnostics?: unknown;
      expected:
        | "source_unreachable"
        | "internal_error"
        | "build_failed"
        | "build_timeout"
        | "policy_rejected";
    }> = [
      { errorCode: "source_archive_unsafe_path", expected: "source_unreachable" },
      // All four are permanent, which is the classification that matters: a different upload changes the answer
      // and a redeploy does not.
      { errorCode: "source_archive_unsafe_link", expected: "source_unreachable" },
      { errorCode: "source_archive_too_many_entries", expected: "source_unreachable" },
      { errorCode: "source_archive_too_large_uncompressed", expected: "source_unreachable" },
      // The compressed-download bound, from `fetch-source.ts` rather than the extractor.
      { errorCode: "source_archive_too_large", expected: "source_unreachable" },
      // Both are permanent source codes: we unwrapped the one level we unwrap and what was inside is either not
      // an archive we read, or another wrapper.
      { errorCode: "source_archive_nested_unsupported", expected: "source_unreachable" },
      { errorCode: "source_archive_nested_too_deep", expected: "source_unreachable" },
      { errorCode: "git_clone_failed", expected: "source_unreachable" },
      // A deploy fixes it and a resubmission cannot, so it must land on the retryable side — the row exists
      // because the prefix makes the opposite classification the easy mistake.
      { errorCode: "source_archive_reader_unavailable", expected: "internal_error" },
      { errorCode: "sandbox_unavailable", expected: "internal_error" },
      { errorCode: "batch_job_failed_no_artifact", expected: "internal_error" },
      // A docker stderr excerpt, which is what `errorCode` holds whenever the sandbox path failed — it matches
      // no allowlist, so only the presence of `diagnostics.docker_error` identifies it.
      {
        errorCode: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        diagnostics: { docker_error: "Cannot connect to the Docker daemon" },
        expected: "internal_error",
      },
      { errorCode: "manifest_path_not_found", expected: "build_failed" },
      // Reads like the `source_archive_reader_unavailable` row above and lands on the other side: the same
      // code also covers a compile that printed a report of its own, which is the source's doing.
      { errorCode: "artifact_report_hash_missing", expected: "build_failed" },
      // Retryability is unchanged: both arms are non-retryable, so only what the submitter is told moves.
      { errorCode: "absolute_manifest_path_not_supported", expected: "policy_rejected" },
      { errorCode: "manifest_path_escapes_source", expected: "policy_rejected" },
      // Genuinely ambiguous, and deliberately on the non-retryable side.
      { errorCode: "dependency_prefetch_failed", expected: "build_failed" },
      { errorCode: "rebuild_timeout", diagnostics: { timed_out: true }, expected: "build_timeout" },
    ];

    for (const { errorCode, diagnostics, expected } of cases) {
      const contract = contractId();
      chain.deployed.set(contract, REBUILT_HASH);
      const job = await createJob({ contractId: contract, sourceSha256: randomBytes(32).toString("hex") });
      await pipeline.run(job);
      const rebuildId = (await reload(job.jobId)).rebuildId!;
      // `build` mode, so `settle` takes the "already the retry" arm rather than requeueing.
      await prisma.$executeRawUnsafe(
        `UPDATE rebuilds SET build_mode = 'build' WHERE id = $1::uuid`,
        rebuildId,
      );
      await rebuilds.markTerminal(rebuildId, {
        outcome: "cli_failure",
        errorCode,
        ...(diagnostics ? { diagnostics } : {}),
      });
      await pipeline.run(await reload(job.jobId));

      const final = await reload(job.jobId);
      expect(final.status).toBe("failed");
      expect([errorCode, final.failureReason]).toEqual([errorCode, expected]);
      expect(final.verdict).toBeNull();
    }
  });

  it("reaps a rebuild whose Batch job went silent, so its attached jobs stop waiting forever", async () => {
    // `advance()` treats `running` as "wait", nothing else ever moved such a row, and because a shared rebuild
    // strands EVERY attached job in `comparing`.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, REBUILT_HASH);

    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    const jobB = await createJob({ contractId: contractB, sourceSha256 });
    await pipeline.run(jobA);
    await pipeline.run(jobB);
    const rebuildId = (await reload(jobA.jobId)).rebuildId!;
    expect((await rebuilds.getById(rebuildId))?.status).toBe("running");

    // A tick while it is legitimately running must change nothing — nothing is past the cutoff yet, so the
    // reconciler does not even ask Batch about it.
    await reconciler.reconcileStuckRebuilds();
    expect((await rebuilds.getById(rebuildId))?.status).toBe("running");
    await pipeline.run(await reload(jobA.jobId));
    expect((await reload(jobA.jobId)).status).toBe("building");

    // Now the terminal event never arrives and the rebuild goes silent past the run timeout.
    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    const reaped = await rebuilds.getById(rebuildId);
    expect(reaped?.status).toBe("done");
    expect(reaped?.outcome).toBe("cli_failure");
    expect(reaped?.errorCode).toBe("rebuild_timeout");

    // Recorded as a verify-mode cli_failure, so the existing policy still grants the one build-mode retry
    // rather than failing the jobs outright.
    await pipeline.run(await reload(jobA.jobId));
    expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");

    // Let that retry also go silent: now both jobs must reach a terminal state.
    await pipeline.run(await reload(jobA.jobId));
    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();
    await pipeline.run(await reload(jobA.jobId));
    await pipeline.run(await reload(jobB.jobId));

    for (const jobId of [jobA.jobId, jobB.jobId]) {
      const final = await reload(jobId);
      expect(final.status).toBe("failed");
      expect(final.failureReason).toBe("build_timeout");
    }
  });

  it("leaves a rebuild alone, however silent, while Batch still reports it RUNNING", async () => {
    // The previous reaper had no way to ask, so it had to outwait the longest legitimate build (90min) or kill
    // healthy compiles.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;
    batch.batchState.set(batchJobId, { status: "RUNNING" });

    // Four hours of silence — far past any timeout — but the build is demonstrably alive.
    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    expect(batch.described).toContain(batchJobId);
    const untouched = await rebuilds.getById(rebuildId);
    expect(untouched?.status).toBe("running");
    expect(untouched?.outcome).toBeUndefined();
    // Nothing was resolved for it by either route. Filtered by rebuild id because one scan sweeps the whole
    // table — earlier cases in this suite leave their own rows behind.
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toHaveLength(0);
  });

  it("recovers the true verdict when Batch succeeded but its terminal event was lost", async () => {
    // The rebuild sat in `running` until the old reaper mislabelled a *passing* verification as a timeout
    // failure.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;

    batch.batchState.set(batchJobId, { status: "SUCCEEDED" });
    outcomes.artifact = {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    };

    await backdateRebuild(rebuildId, 10 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    const resolved = await rebuilds.getById(rebuildId);
    expect(resolved?.status).toBe("done");
    expect(resolved?.outcome).toBe("success");
    expect(resolved?.rebuiltWasmHash).toBe(REBUILT_HASH);
    expect(resolved?.errorCode).toBeUndefined();
    // Resolved through the same route the SQS handler uses, not a synthesised timeout.
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toEqual([
      { via: "batch-terminal", rebuildId },
    ]);

    // And the attached job reaches the verdict it should have had all along.
    await pipeline.run(await reload(job.jobId));
    const final = await reload(job.jobId);
    expect(final.status).toBe("published");
    expect(final.result?.status_summary).toBe("verified");
  });

  it("falls back to the build artifact when Batch has forgotten the job entirely", async () => {
    // Batch retains job records only for a bounded window, so `describeBatchJob` returning undefined is
    // "unknown", not "failed" — the builder's own artifact outlives it and is still authoritative.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;

    // No `batchState` entry: Batch has no record. But the artifact is there.
    outcomes.artifact = {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    };

    await backdateRebuild(rebuildId, 8 * 24 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    const resolved = await rebuilds.getById(rebuildId);
    expect(resolved?.status).toBe("done");
    expect(resolved?.outcome).toBe("success");
    expect(resolved?.rebuiltWasmHash).toBe(REBUILT_HASH);
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toEqual([
      { via: "artifact-only", rebuildId },
    ]);
  });

  it("still resolves from the artifact when Batch cannot be asked at all", async () => {
    // The ECS task role was missing `batch:DescribeJobs`, so rung 1 threw on every pass and took rungs 2 and 3
    // down with it.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;

    batch.describeThrowsFor.add(batchJobId);
    // Deliberately ALSO present in `batchState`: the point is that the answer is unreachable, not absent.
    batch.batchState.set(batchJobId, { status: "SUCCEEDED" });
    outcomes.artifact = {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    };

    await backdateRebuild(rebuildId, 10 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    expect(batch.described).toContain(batchJobId);
    const resolved = await rebuilds.getById(rebuildId);
    expect(resolved?.status).toBe("done");
    expect(resolved?.outcome).toBe("success");
    expect(resolved?.rebuiltWasmHash).toBe(REBUILT_HASH);
    // Resolved on rung 2 — never through the Batch terminal route, which was unreachable.
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toEqual([
      { via: "artifact-only", rebuildId },
    ]);

    // And the verification the user was owed all along actually lands.
    await pipeline.run(await reload(job.jobId));
    const final = await reload(job.jobId);
    expect(final.status).toBe("published");
    expect(final.result?.status_summary).toBe("verified");
  });

  it("refuses to synthesise a timeout when Batch could not be asked and no artifact exists", async () => {
    // The other half of the degradation rule.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;

    batch.describeThrowsFor.add(batchJobId);
    outcomes.artifact = null; // nothing uploaded either

    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    const untouched = await rebuilds.getById(rebuildId);
    expect(untouched?.status).toBe("running");
    expect(untouched?.outcome).toBeUndefined();
    expect(untouched?.errorCode).toBeUndefined();

    // Once Batch can be asked again, the ordinary path resolves it — no state was lost by waiting.
    batch.describeThrowsFor.delete(batchJobId);
    batch.batchState.set(batchJobId, { status: "SUCCEEDED" });
    outcomes.artifact = {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    };
    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();
    expect((await rebuilds.getById(rebuildId))?.outcome).toBe("success");
  });

  it("stops reporting a silent rebuild as `building`, and resumes when it recovers", async () => {
    // Every submission attaching to the same wedged row inherited the same lie.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    expect((await reload(job.jobId)).progress?.step).toBe("building");

    // A tick while the rebuild is legitimately in flight must not cry stalled.
    await pipeline.run(await reload(job.jobId));
    expect((await reload(job.jobId)).progress?.step).toBe("building");

    // Now it goes silent past the reconciliation threshold.
    await backdateRebuild(rebuildId, 10 * 60_000);
    await pipeline.run(await reload(job.jobId));
    const stalled = await reload(job.jobId);
    expect(stalled.status).toBe("building"); // still waiting — this is reporting, not a verdict
    expect(stalled.progress?.step).toBe("rebuild_stalled");
    expect(stalled.progress?.detail).toMatch(/has not reported back/);

    // Reporting only: the rebuild itself is untouched, because re-dispatching a `running` row would duplicate a
    // build that may still be alive (RebuildReconcilerScheduler owns that decision).
    const dispatches = batch.submissions.filter((s) => s.rebuildId === rebuildId).length;
    await pipeline.run(await reload(job.jobId));
    expect((await rebuilds.getById(rebuildId))?.status).toBe("running");
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId)).toHaveLength(dispatches);

    // And it is not a one-way door: the reconciler releases the row, the poll loop re-dispatches it, and the
    // job goes back to reporting an ordinary rebuild rather than staying stuck on the warning.
    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET status = 'pending', batch_job_id = NULL WHERE id = $1::uuid`,
      rebuildId,
    );
    await pipeline.run(await reload(job.jobId)); // wins the CAS, re-dispatches, fresh updated_at
    await pipeline.run(await reload(job.jobId));
    expect((await reload(job.jobId)).progress?.step).toBe("building");
  });

  it("releases a rebuild wedged in `dispatching` back to `pending` for a clean re-dispatch", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;

    // Simulate a crash between winning the CAS claim and `markDispatched` recording the Batch id.
    await rebuilds.requeueStaleCliFailure(rebuildId); // -> pending (reuses the reset path)
    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET status = 'dispatching' WHERE id = $1::uuid`,
      rebuildId,
    );
    await backdateRebuild(rebuildId, 30 * 60_000);

    await reconciler.reconcileStuckRebuilds();

    // Back in the pool — not marked terminal: nothing proves the build itself is broken.
    expect((await rebuilds.getById(rebuildId))?.status).toBe("pending");
    const dispatchesBefore = batch.submissions.filter((s) => s.rebuildId === rebuildId).length;
    await pipeline.run(await reload(job.jobId));
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId)).toHaveLength(
      dispatchesBefore + 1,
    );
  });

  it("fails only the job whose own target stopped resolving, leaving the shared rebuild usable", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, REBUILT_HASH);

    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    const jobB = await createJob({ contractId: contractB, sourceSha256 });
    await pipeline.run(jobA);
    await pipeline.run(jobB);
    const rebuildId = (await reload(jobA.jobId)).rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });

    // B's chain lookup breaks; A's is fine. B must fail alone — the rebuild is still good for A.
    chain.failing.add(contractB);

    await pipeline.run(await reload(jobA.jobId));
    await pipeline.run(await reload(jobB.jobId));

    expect((await reload(jobA.jobId)).status).toBe("published");
    expect((await reload(jobB.jobId)).status).toBe("failed");
    expect((await reload(jobB.jobId)).failureReason).toBe("internal_error");
    // The rebuild itself is untouched by one job's target problem.
    expect((await rebuilds.getById(rebuildId))?.outcome).toBe("success");
  });

  it("is re-entrant: extra ticks on a settled job neither republish nor redispatch", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    const rebuildId = attached.rebuildId!;
    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(attached);

    const published = await reload(job.jobId);
    const dispatchCount = batch.submissions.filter((s) => s.rebuildId === rebuildId).length;

    // The poll loop filters these out by `!job.result`, but the service must be safe regardless.
    await pipeline.run(published);
    await pipeline.run(await reload(job.jobId));

    expect((await reload(job.jobId)).status).toBe("published");
    expect((await reload(job.jobId)).result?.artifact_sha256).toBe(
      published.result?.artifact_sha256
    );
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId)).toHaveLength(dispatchCount);
  });

  it("republishStoredResult lands at the SAME reports/<sha>.json key as the original publish (RA1/RA2)", async () => {
    // `republishStoredResult` is `rescan.ts`'s `rebuild-indexes` entry point — its whole purpose is restoring a
    // lost result tree at its ORIGINAL keys.
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    await rebuilds.markTerminal(attached.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });
    await pipeline.run(attached);

    const published = await reload(job.jobId);
    expect(published.status).toBe("published");
    const originalSha256 = published.result?.artifact_sha256;
    expect(originalSha256).toBeDefined();
    const originalArtifact = await readFile(
      join(resultRoot, "reports", `${originalSha256}.json`),
      "utf8",
    );
    // This suite shares one `reports/` directory across every case (`resultRoot` is set up once in
    // `beforeAll`), so the directory already holds other tests' reports by the time this one runs.
    const reportFilesBeforeRepublish = new Set(await readdir(join(resultRoot, "reports")));

    await publish.republishStoredResult(job.jobId);

    // The row is untouched — `republishStoredResult` never claims ownership of it (`ownsRow: false`).
    const afterRepublish = await reload(job.jobId);
    expect(afterRepublish.result?.artifact_sha256).toBe(originalSha256);
    expect(afterRepublish.status).toBe("published");

    // Comparing the directory listing before/after (not just re-reading the known key) is what catches that:
    // re-reading only the original key would pass even with the bug present, since the original file is never
    // overwritten.
    const reportFilesAfterRepublish = await readdir(join(resultRoot, "reports"));
    expect(reportFilesAfterRepublish.sort()).toEqual(Array.from(reportFilesBeforeRepublish).sort());

    // The original file is still byte-identical to what the first publish wrote.
    const reReadArtifact = await readFile(
      join(resultRoot, "reports", `${originalSha256}.json`),
      "utf8",
    );
    expect(reReadArtifact).toBe(originalArtifact);
  });
});

/**
 * Everything needed already existed — the DTO field, the OpenAPI contract, the console's renderer, and a
 * validated `SandboxDiagnostics` on `rebuild.diagnostics`.
 */
describe("a failed job reports what the sandbox saw", () => {
  /** The real stderr from job `95b5a72f…`, which needed CloudWatch to read this morning. */
  const LOCKED_DIAGNOSTICS = {
    runner: "docker_build_image_rebuild",
    exit_code: 2,
    stderr_excerpt: "error: unexpected argument '--locked' found\nUsage: stellar contract build [OPTIONS]",
    rejected_build_option: "--locked",
    rejected_build_option_origin: "recorded_bldopt",
  };

  const failWithDiagnostics = async (diagnostics?: Record<string, unknown>) => {
    const contract = contractId();
    // These jobs all end `failed`, so the hash never has to match anything.
    chain.deployed.set(contract, randomBytes(32).toString("hex"));
    const job = await createJob({ contractId: contract, sourceSha256: randomBytes(32).toString("hex") });

    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    // `buildMode` is not a `markTerminal` input; going through the column is what actually works.
    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET build_mode = 'build' WHERE id = $1::uuid`,
      rebuildId,
    );
    await rebuilds.markTerminal(rebuildId, {
      outcome: "cli_failure",
      runner: "docker_build_image_rebuild",
      errorCode: "rebuild_command_failed",
      ...(diagnostics ? { diagnostics } : {}),
    });
    await pipeline.run(await reload(job.jobId));

    return reload(job.jobId);
  };

  it("carries the sandbox's own stderr, which is what needed CloudWatch before", async () => {
    const failed = await failWithDiagnostics(LOCKED_DIAGNOSTICS);
    const result = failed.result as Record<string, unknown>;

    expect(failed.status).toBe("failed");
    const diagnostics = result.sandbox_diagnostics as Record<string, unknown>;
    expect(diagnostics).toBeDefined();
    expect(diagnostics.stderr_excerpt).toContain("unexpected argument '--locked' found");
    expect(diagnostics.rejected_build_option).toBe("--locked");
  });

  it("leaves the four fields a failed job already carried alone", async () => {
    // Additive, not a rewrite: whatever a submitter or the console reads today must still be there.
    const failed = await failWithDiagnostics(LOCKED_DIAGNOSTICS);
    const result = failed.result as Record<string, unknown>;

    expect(result.status_summary).toBe("build_failed");
    expect(result.reason).toBe("rebuild_command_failed");
    expect(result.detail).toBeTruthy();
    expect(result.verified_at).toBeTruthy();
  });

  it("★ records exactly what it did before when the rebuild carries no diagnostics", async () => {
    // Every failure path that never reached a sandbox — a policy rejection, a chain-lookup failure, a
    // configuration fault — must be untouched by this change.
    const failed = await failWithDiagnostics();
    const result = failed.result as Record<string, unknown>;

    expect(failed.status).toBe("failed");
    expect(result.sandbox_diagnostics).toBeUndefined();
    // On *values*, not on `Object.keys`: `reload` returns a `parseDto` instance, whose declared optional fields
    // all exist as `undefined`, so a key-list assertion would describe the DTO rather than what was written.
    expect(
      Object.entries(result)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort(),
    ).toEqual(["detail", "reason", "status_summary", "verified_at", "wasm_hash"]);
  });

  // Not covered here: that `failJob` reads `rebuildId` from its own re-read of the row rather than from the
  // caller's copy.
});
