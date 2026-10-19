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

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;
const REBUILT_HASH = "1".repeat(64);
const OTHER_HASH = "2".repeat(64);
/** `localhost` is refused by the destination policy before a socket opens, so no case makes a live request. */
const SUBMITTED_SOURCE_URI = "https://localhost/e2e.tar.gz";

class StubChainReader {
  readonly deployed = new Map<string, string>();
  readonly replay = new Map<string, string[]>();
  readonly failing = new Set<string>();
  readonly cliNone = new Set<string>();
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

class StubBatchDispatch {
  readonly submissions: {
    rebuildId: string;
    mode: string;
    pinnedHash?: string;
    buildOptions?: string[];
    buildArgs?: string[];
    metadataReplay?: string[];
  }[] = [];
  readonly batchState = new Map<string, { status: string; statusReason?: string }>();
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

class StubMismatchDiagnostics {
  readonly calls: { rebuildId: string; buildMode: string }[] = [];

  async describe(input: { rebuildId: string; buildMode: string }): Promise<undefined> {
    this.calls.push({ rebuildId: input.rebuildId, buildMode: input.buildMode });
    return undefined;
  }
}

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
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-e2e-results-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4999";
  process.env.SCVS_ARWEAVE_MODE = "disabled";

  chain = new StubChainReader();

  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
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

afterAll(async () => {
  try {
    // Stop background archive work before deleting the rows it writes.
    if (moduleRef) await moduleRef.get(ArweaveArchiveService).onModuleDestroy();
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

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
  beforeEach(() => {
    outcomes.artifact = null;
    outcomes.calls.length = 0;
    batch.batchState.clear();
    batch.describeThrowsFor.clear();
    batch.described.length = 0;
    chain.replay.clear();
  });

  it("shares one rebuild across two targets and gives each its own independently-computed verdict", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, OTHER_HASH);
    const explainedBefore = mismatchDiagnostics.calls.length;

    const jobA = await createJob({ contractId: contractA, sourceSha256 });
    const jobB = await createJob({ contractId: contractB, sourceSha256 });

    await pipeline.run(jobA);
    await pipeline.run(jobB);

    const attachedA = await reload(jobA.jobId);
    const attachedB = await reload(jobB.jobId);
    expect(attachedA.rebuildId).toBeDefined();
    expect(attachedB.rebuildId).toBe(attachedA.rebuildId);
    expect(batch.submissions.filter((s) => s.rebuildId === attachedA.rebuildId)).toHaveLength(1);
    expect([REBUILT_HASH, OTHER_HASH]).toContain(
      batch.submissions.find((s) => s.rebuildId === attachedA.rebuildId)!.pinnedHash
    );

    await rebuilds.markTerminal(attachedA.rebuildId!, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: REBUILT_HASH,
    });

    await pipeline.run(attachedA);
    await pipeline.run(attachedB);

    const finalA = await reload(jobA.jobId);
    const finalB = await reload(jobB.jobId);

    expect(finalA.status).toBe("published");
    expect(finalA.result?.matched).toBe(true);
    expect(finalA.result?.status_summary).toBe("verified");

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

    expect(finalA.result?.artifact_sha256).toBeDefined();
    expect(finalB.result?.artifact_sha256).toBeDefined();
    expect(finalA.result?.artifact_sha256).not.toBe(finalB.result?.artifact_sha256);

    expect(mismatchDiagnostics.calls).toHaveLength(explainedBefore + 1);
    expect(mismatchDiagnostics.calls.at(-1)).toEqual({
      rebuildId: attachedA.rebuildId,
      buildMode: "build",
    });
    expect(finalB.result?.status_summary).toBe("mismatch");

    expect(finalB.sourcePublishPendingSince).toBeDefined();
    expect(finalB.sourceFileName).toBeUndefined();
    expect(finalB.sourcePublishAttempts).toBe(1);
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
    chain.deployed.set(contract, REBUILT_HASH);

    await pipeline.run(attached);
    const final = await reload(job.jobId);

    expect(final.result?.contract_binding_drifted).toBe(true);
    expect(final.result?.matched).toBe(true);
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
    chain.recordedRecipe.set(contract, { bldopt: ["--features", "production"] });

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);

    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const dispatched = batch.submissions.filter((s) => s.rebuildId === rebuildId);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].mode).toBe("build");
    expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");
  });

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

    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId).at(-1)?.mode).toBe("build");

    await rebuilds.markTerminal(rebuildId, {
      outcome: "cli_failure",
      runner: "docker_build_image_rebuild",
      errorCode: "rebuild_command_failed",
    });

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

    expect((await reload(job.jobId)).status).toBe("building");
  });

  it("stops reporting 'waiting on the rebuild' once the rebuild is done, even if publishing fails", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);

    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const attached = await reload(job.jobId);
    expect(attached.progress?.detail).toMatch(/sandbox rebuild/);
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
    expect(wedged.result?.status_summary).toBe("running");
    expect(wedged.progress?.step).toBe("publish_failed");
    expect(wedged.progress?.detail).not.toMatch(/sandbox rebuild/);
    expect(wedged.progress?.detail).toMatch(/attempt 1 of \d+/);
    expect(wedged.publishAttempts).toBe(1);
    expect(wedged.progress?.detail).not.toMatch(/stub: result storage unavailable/);

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

    // One attempt short of the default budget of 10.
    await jobs.updateJob(job.jobId, { publishAttempts: 9 });

    await withBrokenPublishing(async () => {
      await pipeline.run(await reload(job.jobId));
    });

    const abandoned = await reload(job.jobId);
    expect(abandoned.publishAttempts).toBe(10);
    expect(abandoned.progress?.step).toBe("publish_abandoned");
    expect(abandoned.progress?.detail).toMatch(/will not be retried automatically/);
    expect(abandoned.result?.matched).toBe(true);
  });

  it("re-opens a job that failed on a rebuild which is later revived and succeeds", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contractA = contractId();
    const contractB = contractId();
    chain.deployed.set(contractA, REBUILT_HASH);
    chain.deployed.set(contractB, REBUILT_HASH);

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

    const jobB = await createJob({ contractId: contractB, sourceSha256 });
    await pipeline.run(jobB);
    expect((await reload(jobB.jobId)).rebuildId).toBe(rebuildId);

    const reopenedA = await reload(jobA.jobId);
    expect(reopenedA.status).toBe("building");
    expect(reopenedA.failureReason).toBeNull();
    expect(reopenedA.error).toBeUndefined();
    expect(reopenedA.result).toBeUndefined();

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
    chain.failing.add(unresolvable);
    await pipeline.run(await reload(jobOwnFailure.jobId));
    const failed = await reload(jobOwnFailure.jobId);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("internal_error");
    expect(failed.error).toBe("stellar_contract_fetch_failed");

    await rebuilds.markTerminal(rebuildId, { outcome: "cli_failure", errorCode: "later_failure" });
    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET build_mode = 'build' WHERE id = $1::uuid`,
      rebuildId,
    );
    const jobFresh = await createJob({ contractId: other, sourceSha256 });
    await pipeline.run(jobFresh);

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
    const deleteStagedUploadSpy = jest.spyOn(sourceResolution, "deleteStagedUpload");
    await pipeline.run(await reload(job.jobId));
    expect(deleteStagedUploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "source_uri" }),
    );
    deleteStagedUploadSpy.mockRestore();

    const evaluated = await reload(job.jobId);
    expect(evaluated.status).toBe("evaluated");
    expect(evaluated.verdict).toBe("verified");
    expect(evaluated.failureReason).toBeNull();
    expect(evaluated.result?.matched).toBe(true);
    expect(evaluated.result?.status_summary).toBe("verified");
    expect(evaluated.result?.artifact_sha256).toBeUndefined();
    expect(evaluated.publishedUpdatedAt).toBeUndefined();
    expect(evaluated.result?.verified_at).toBeUndefined();
    expect(evaluated.completedAt).toBeDefined();
    expect(evaluated.archivePendingSince).toBeUndefined();

    await pipeline.run(evaluated);
    expect((await reload(job.jobId)).status).toBe("evaluated");
  });

  it("does not let a dry run's verdict short-circuit a later real submission (TRD §7.6)", async () => {
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

    const deleteStagedUploadSpy = jest.spyOn(sourceResolution, "deleteStagedUpload");
    const jobSecond = await createJob({ contractId: second, sourceSha256 });
    await pipeline.run(jobSecond);
    expect((await reload(jobSecond.jobId)).rebuildId).toBe(rebuildId);
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
    expect(adopted.publishedUpdatedAt).toBeUndefined();
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

    const upgraded = contractId();
    chain.deployed.set(upgraded, OTHER_HASH);
    const jobUpgraded = await createJob({ contractId: upgraded, sourceSha256 });
    await pipeline.run(jobUpgraded);
    await pipeline.run(await reload(jobUpgraded.jobId));
    const mismatched = await reload(jobUpgraded.jobId);
    expect(mismatched.verdict).toBe("mismatched");
    expect(mismatched.result?.artifact_sha256).not.toBe(published.result?.artifact_sha256);

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
    expect(notAdopted.publishedUpdatedAt).toBeDefined();
  });

  it("adopts a verdict across networks (TRD §7.7 — a verdict attaches to a Wasm hash, not a network)", async () => {
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
    expect((await reload(adopter.jobId)).rebuildId).toBe(rebuildId);
    await pipeline.run(await reload(adopter.jobId));

    const adopted = await reload(adopter.jobId);
    expect(adopted.status).toBe("published");
    expect(adopted.verdict).toBe("verified");
    expect(adopted.result?.artifact_sha256).toBe(published.result?.artifact_sha256);
    expect(adopted.publishedUpdatedAt).toBeUndefined();

    expect(adopted.target.network).toBe("mainnet");
    expect(adopted.target.contract_id).toBe(mainnetContract);

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

    const exhausted = await createJob({ contractId: contractId(), sourceSha256 });
    await jobs.advanceJob(exhausted.jobId, "queued", "failed", {
      failureReason: "internal_error",
      retryAttempts: 3,
    });

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
      { errorCode: "source_archive_unsafe_link", expected: "source_unreachable" },
      { errorCode: "source_archive_too_many_entries", expected: "source_unreachable" },
      { errorCode: "source_archive_too_large_uncompressed", expected: "source_unreachable" },
      { errorCode: "source_archive_too_large", expected: "source_unreachable" },
      { errorCode: "source_archive_nested_unsupported", expected: "source_unreachable" },
      { errorCode: "source_archive_nested_too_deep", expected: "source_unreachable" },
      { errorCode: "source_archive_conflicting_entries", expected: "source_unreachable" },
      { errorCode: "git_clone_failed", expected: "source_unreachable" },
      { errorCode: "source_archive_reader_unavailable", expected: "internal_error" },
      { errorCode: "sandbox_unavailable", expected: "internal_error" },
      { errorCode: "batch_job_failed_no_artifact", expected: "internal_error" },
      {
        errorCode: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        diagnostics: { docker_error: "Cannot connect to the Docker daemon" },
        expected: "internal_error",
      },
      { errorCode: "manifest_path_not_found", expected: "build_failed" },
      { errorCode: "artifact_report_hash_missing", expected: "build_failed" },
      { errorCode: "absolute_manifest_path_not_supported", expected: "policy_rejected" },
      { errorCode: "manifest_path_escapes_source", expected: "policy_rejected" },
      { errorCode: "dependency_prefetch_failed", expected: "build_failed" },
      { errorCode: "rebuild_timeout", diagnostics: { timed_out: true }, expected: "build_timeout" },
    ];

    for (const { errorCode, diagnostics, expected } of cases) {
      const contract = contractId();
      chain.deployed.set(contract, REBUILT_HASH);
      const job = await createJob({ contractId: contract, sourceSha256: randomBytes(32).toString("hex") });
      await pipeline.run(job);
      const rebuildId = (await reload(job.jobId)).rebuildId!;
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

    await reconciler.reconcileStuckRebuilds();
    expect((await rebuilds.getById(rebuildId))?.status).toBe("running");
    await pipeline.run(await reload(jobA.jobId));
    expect((await reload(jobA.jobId)).status).toBe("building");

    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    const reaped = await rebuilds.getById(rebuildId);
    expect(reaped?.status).toBe("done");
    expect(reaped?.outcome).toBe("cli_failure");
    expect(reaped?.errorCode).toBe("rebuild_timeout");

    await pipeline.run(await reload(jobA.jobId));
    expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");

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
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;
    batch.batchState.set(batchJobId, { status: "RUNNING" });

    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    expect(batch.described).toContain(batchJobId);
    const untouched = await rebuilds.getById(rebuildId);
    expect(untouched?.status).toBe("running");
    expect(untouched?.outcome).toBeUndefined();
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toHaveLength(0);
  });

  it("recovers the true verdict when Batch succeeded but its terminal event was lost", async () => {
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
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toEqual([
      { via: "batch-terminal", rebuildId },
    ]);

    await pipeline.run(await reload(job.jobId));
    const final = await reload(job.jobId);
    expect(final.status).toBe("published");
    expect(final.result?.status_summary).toBe("verified");
  });

  it("falls back to the build artifact when Batch has forgotten the job entirely", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;

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
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;

    batch.describeThrowsFor.add(batchJobId);
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
    expect(outcomes.calls.filter((c) => c.rebuildId === rebuildId)).toEqual([
      { via: "artifact-only", rebuildId },
    ]);

    await pipeline.run(await reload(job.jobId));
    const final = await reload(job.jobId);
    expect(final.status).toBe("published");
    expect(final.result?.status_summary).toBe("verified");
  });

  it("refuses to synthesise a timeout when Batch could not be asked and no artifact exists", async () => {
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    const batchJobId = (await rebuilds.getById(rebuildId))!.batchJobId!;

    batch.describeThrowsFor.add(batchJobId);
    outcomes.artifact = null;

    await backdateRebuild(rebuildId, 4 * 60 * 60_000);
    await reconciler.reconcileStuckRebuilds();

    const untouched = await rebuilds.getById(rebuildId);
    expect(untouched?.status).toBe("running");
    expect(untouched?.outcome).toBeUndefined();
    expect(untouched?.errorCode).toBeUndefined();

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
    const sourceSha256 = randomBytes(32).toString("hex");
    const contract = contractId();
    chain.deployed.set(contract, REBUILT_HASH);
    const job = await createJob({ contractId: contract, sourceSha256 });
    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
    expect((await reload(job.jobId)).progress?.step).toBe("building");

    await pipeline.run(await reload(job.jobId));
    expect((await reload(job.jobId)).progress?.step).toBe("building");

    await backdateRebuild(rebuildId, 10 * 60_000);
    await pipeline.run(await reload(job.jobId));
    const stalled = await reload(job.jobId);
    expect(stalled.status).toBe("building");
    expect(stalled.progress?.step).toBe("rebuild_stalled");
    expect(stalled.progress?.detail).toMatch(/has not reported back/);

    const dispatches = batch.submissions.filter((s) => s.rebuildId === rebuildId).length;
    await pipeline.run(await reload(job.jobId));
    expect((await rebuilds.getById(rebuildId))?.status).toBe("running");
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId)).toHaveLength(dispatches);

    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET status = 'pending', batch_job_id = NULL WHERE id = $1::uuid`,
      rebuildId,
    );
    await pipeline.run(await reload(job.jobId));
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

    await rebuilds.requeueStaleCliFailure(rebuildId);
    await prisma.$executeRawUnsafe(
      `UPDATE rebuilds SET status = 'dispatching' WHERE id = $1::uuid`,
      rebuildId,
    );
    await backdateRebuild(rebuildId, 30 * 60_000);

    await reconciler.reconcileStuckRebuilds();

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

    chain.failing.add(contractB);

    await pipeline.run(await reload(jobA.jobId));
    await pipeline.run(await reload(jobB.jobId));

    expect((await reload(jobA.jobId)).status).toBe("published");
    expect((await reload(jobB.jobId)).status).toBe("failed");
    expect((await reload(jobB.jobId)).failureReason).toBe("internal_error");
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

    await pipeline.run(published);
    await pipeline.run(await reload(job.jobId));

    expect((await reload(job.jobId)).status).toBe("published");
    expect((await reload(job.jobId)).result?.artifact_sha256).toBe(
      published.result?.artifact_sha256
    );
    expect(batch.submissions.filter((s) => s.rebuildId === rebuildId)).toHaveLength(dispatchCount);
  });

  it("republishStoredResult lands at the SAME reports/<sha>.json key as the original publish (RA1/RA2)", async () => {
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
    const reportFilesBeforeRepublish = new Set(await readdir(join(resultRoot, "reports")));

    await publish.republishStoredResult(job.jobId);

    const afterRepublish = await reload(job.jobId);
    expect(afterRepublish.result?.artifact_sha256).toBe(originalSha256);
    expect(afterRepublish.status).toBe("published");

    const reportFilesAfterRepublish = await readdir(join(resultRoot, "reports"));
    expect(reportFilesAfterRepublish.sort()).toEqual(Array.from(reportFilesBeforeRepublish).sort());

    const reReadArtifact = await readFile(
      join(resultRoot, "reports", `${originalSha256}.json`),
      "utf8",
    );
    expect(reReadArtifact).toBe(originalArtifact);
  });
});

describe("a failed job reports what the sandbox saw", () => {
  const LOCKED_DIAGNOSTICS = {
    runner: "docker_build_image_rebuild",
    exit_code: 2,
    stderr_excerpt: "error: unexpected argument '--locked' found\nUsage: stellar contract build [OPTIONS]",
    rejected_build_option: "--locked",
    rejected_build_option_origin: "recorded_bldopt",
  };

  const failWithDiagnostics = async (diagnostics?: Record<string, unknown>) => {
    const contract = contractId();
    chain.deployed.set(contract, randomBytes(32).toString("hex"));
    const job = await createJob({ contractId: contract, sourceSha256: randomBytes(32).toString("hex") });

    await pipeline.run(job);
    const rebuildId = (await reload(job.jobId)).rebuildId!;
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
    const failed = await failWithDiagnostics(LOCKED_DIAGNOSTICS);
    const result = failed.result as Record<string, unknown>;

    expect(result.status_summary).toBe("build_failed");
    expect(result.reason).toBe("rebuild_command_failed");
    expect(result.detail).toBeTruthy();
    expect(result.verified_at).toBeTruthy();
  });

  it("★ records exactly what it did before when the rebuild carries no diagnostics", async () => {
    const failed = await failWithDiagnostics();
    const result = failed.result as Record<string, unknown>;

    expect(failed.status).toBe("failed");
    expect(result.sandbox_diagnostics).toBeUndefined();
    expect(
      Object.entries(result)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort(),
    ).toEqual(["detail", "reason", "status_summary", "verified_at", "wasm_hash"]);
  });
});
