import { jest } from "@jest/globals";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DbModule, JobsRepository, PRISMA_CLIENT, RebuildsRepository, type JobRecord, type PrismaClient } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { sourceKeyFromFileName } from "@scvs/storage-layout";
import type { SourceReference } from "@scvs/core";

const fetchThroughDestinationPolicy = jest.fn<(...args: unknown[]) => Promise<never>>();
fetchThroughDestinationPolicy.mockRejectedValue(new Error("publication must not fetch from a submitter URL"));
jest.unstable_mockModule("@scvs/core/policy-bound-fetch", () => ({ fetchThroughDestinationPolicy }));

const { default: configuration } = await import("../src/config/configuration.js");
type AppConfigService = import("../src/config/configuration.js").AppConfigService;
const { PublishService } = await import("../src/modules/publish/publish.service.js");
const { ArweaveArchiveService } = await import("../src/modules/publish/arweave-archive.service.js");
const { SourceResolutionService } = await import("../src/modules/source-resolution/source-resolution.service.js");
const { StagedSourceReleaseService } = await import("../src/modules/source-resolution/staged-source-release.service.js");

const WASM_HASH = "9".repeat(64);
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;
const SOURCE_URI = "https://example.com/archives/counter.tar.gz";

let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
let publish: InstanceType<typeof PublishService>;
let sourceResolution: InstanceType<typeof SourceResolutionService>;
let resultRoot: string;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();
const deletedKeys: string[] = [];

beforeAll(async () => {
  resultRoot = await mkdtemp(join(tmpdir(), "scvs-publish-from-staging-test-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultRoot;
  process.env.SCVS_PUBLIC_RESULT_ROOT = "http://localhost:4995";
  process.env.SCVS_ARWEAVE_MODE = "disabled";

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
  sourceResolution = moduleRef.get(SourceResolutionService);
  prisma = moduleRef.get(PRISMA_CLIENT);
  jest.spyOn(sourceResolution, "deleteStagingObject").mockImplementation(async (key: string) => {
    deletedKeys.push(key);
  });
});

afterAll(async () => {
  try {
    if (moduleRef) await moduleRef.get(ArweaveArchiveService).onModuleDestroy();
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

beforeEach(() => {
  deletedKeys.length = 0;
  fetchThroughDestinationPolicy.mockClear();
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Staged = Record<string, Uint8Array>;

/** The job is in `comparing` with a verdict, attached to a finished rebuild: exactly what publishJobResult picks up. */
async function createComparedJob(
  sourceRef: SourceReference,
  canonical?: { bytes: Uint8Array; sha256: string },
): Promise<{ job: JobRecord; rebuildId: string }> {
  const job = await jobs.createJob({
    dryRun: false,
    jobId: createdRows.job(randomUUID()),
    target: { network: "testnet", wasm_hash: WASM_HASH },
    verificationMode: "submitted",
    sourceRef,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: "testnet", wasm_hash: WASM_HASH },
      bldimg: IMAGE,
      source_sha256: sourceRef.source_sha256,
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
    rebuiltWasmHash: WASM_HASH,
    ...(canonical
      ? {
          canonicalSourceSha256: canonical.sha256,
          canonicalSourceKey: `staging/${rebuild.rebuildId}/verify/canonical-source`,
          sourceCanonicalisation: { depth: 1, canonical_format: "gzip", canonical_sha256: canonical.sha256, uploaded: true },
        }
      : {}),
  });

  await jobs.advanceJob(job.jobId, "queued", "comparing", {
    rebuildId: rebuild.rebuildId,
    verdict: "verified",
    result: { wasm_hash: WASM_HASH, matched: true, rebuilt_wasm_hash: WASM_HASH, status_summary: "verified" } as never,
  });
  return { job: (await jobs.getJobById(job.jobId))!, rebuildId: rebuild.rebuildId };
}

function stageObjects(staged: Staged): void {
  jest.spyOn(sourceResolution, "readStagingObjectBytes").mockImplementation(async (key: string) => staged[key]);
}

const publicUrlRef = (bytes: Uint8Array): SourceReference => ({
  type: "source_uri",
  visibility: "public",
  source_uri: SOURCE_URI,
  source_sha256: sha256(bytes),
});

async function publishedSource(sourceFileName: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(join(resultRoot, sourceKeyFromFileName(sourceFileName))));
  } catch {
    return undefined;
  }
}

describe("publishing a public source reads the staged copy and re-hashes it; it never fetches", () => {
  it("writes sources/<sha256><ext> from the copy staged before the build", async () => {
    const bytes = randomBytes(96);
    const { job, rebuildId } = await createComparedJob(publicUrlRef(bytes));
    stageObjects({ [`staging/${rebuildId}/verify/fetched-source`]: bytes });

    await publish.publishJobResult(job.jobId);

    const reloaded = (await jobs.getJobById(job.jobId))!;
    expect(reloaded.status).toBe("published");
    expect(reloaded.sourceFileName).toBe(`${sha256(bytes)}.tar.gz`);
    expect(reloaded.sourcePublishPendingSince).toBeUndefined();
    expect(await publishedSource(reloaded.sourceFileName!)).toEqual(bytes);
    expect(fetchThroughDestinationPolicy).not.toHaveBeenCalled();
    expect(deletedKeys).toContain(`staging/${rebuildId}/verify/fetched-source`);
    expect((await rebuilds.getById(rebuildId))!.stagedSourceReleasedAt).toBeDefined();
  });

  it("refuses to publish when the staged bytes do not hash to the declared sha256, and keeps the copy for a human to look at", async () => {
    const declared = randomBytes(96);
    const { job, rebuildId } = await createComparedJob(publicUrlRef(declared));
    stageObjects({ [`staging/${rebuildId}/verify/fetched-source`]: randomBytes(96) });

    await publish.publishJobResult(job.jobId);

    const reloaded = (await jobs.getJobById(job.jobId))!;
    expect(reloaded.status).toBe("published");
    expect(reloaded.verdict).toBe("verified");
    expect(reloaded.sourceFileName).toBeUndefined();
    expect(reloaded.sourcePublishPendingSince).toBeDefined();
    expect(await publishedSource(`${sha256(declared)}.tar.gz`)).toBeUndefined();
    expect(fetchThroughDestinationPolicy).not.toHaveBeenCalled();
    expect(deletedKeys).toEqual([]);
    expect((await rebuilds.getById(rebuildId))!.stagedSourceReleasedAt).toBeUndefined();
  });

  it("publishes the verdict without the source when no staged copy exists, rather than fetching the URL again", async () => {
    const bytes = randomBytes(96);
    const { job } = await createComparedJob(publicUrlRef(bytes));
    stageObjects({});

    await publish.publishJobResult(job.jobId);

    const reloaded = (await jobs.getJobById(job.jobId))!;
    expect(reloaded.status).toBe("published");
    expect(reloaded.sourceFileName).toBeUndefined();
    expect(reloaded.sourcePublishPendingSince).toBeDefined();
    expect(await publishedSource(`${sha256(bytes)}.tar.gz`)).toBeUndefined();
    expect(fetchThroughDestinationPolicy).not.toHaveBeenCalled();
  });

  it("publishes a canonical archive only when its bytes still hash to the canonical sha256 the trusted side recorded", async () => {
    const submitted = randomBytes(96);
    const canonicalBytes = randomBytes(80);
    const { job, rebuildId } = await createComparedJob(publicUrlRef(submitted), { bytes: canonicalBytes, sha256: sha256(canonicalBytes) });
    stageObjects({ [`staging/${rebuildId}/verify/canonical-source`]: randomBytes(80) });

    await publish.publishJobResult(job.jobId);

    const refused = (await jobs.getJobById(job.jobId))!;
    expect(refused.sourceFileName).toBeUndefined();
    expect(await publishedSource(`${sha256(canonicalBytes)}.tar.gz`)).toBeUndefined();

    stageObjects({ [`staging/${rebuildId}/verify/canonical-source`]: canonicalBytes });
    await publish.retryPendingSourcePublish(refused);

    const published = (await jobs.getJobById(job.jobId))!;
    expect(published.sourceFileName).toBe(`${sha256(canonicalBytes)}.tar.gz`);
    expect(await publishedSource(published.sourceFileName!)).toEqual(canonicalBytes);
    expect(fetchThroughDestinationPolicy).not.toHaveBeenCalled();
  });

  it("a private job publishes nothing from staging and releases every copy at termination", async () => {
    const bytes = randomBytes(96);
    const { job, rebuildId } = await createComparedJob({ ...publicUrlRef(bytes), visibility: "private" });
    const read = jest.spyOn(sourceResolution, "readStagingObjectBytes").mockResolvedValue(bytes);
    read.mockClear();

    await publish.publishJobResult(job.jobId);

    const reloaded = (await jobs.getJobById(job.jobId))!;
    expect(reloaded.status).toBe("published");
    expect(reloaded.sourceFileName).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(await publishedSource(`${sha256(bytes)}.tar.gz`)).toBeUndefined();
    expect(deletedKeys.sort()).toEqual(
      [
        `staging/${rebuildId}/verify/fetched-source`,
        `staging/${rebuildId}/verify/canonical-source`,
        `staging/${rebuildId}/build/fetched-source`,
        `staging/${rebuildId}/build/canonical-source`,
      ].sort(),
    );
    expect((await rebuilds.getById(rebuildId))!.stagedSourceReleasedAt).toBeDefined();
  });
});
