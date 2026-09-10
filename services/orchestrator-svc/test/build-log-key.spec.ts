import { randomBytes, randomUUID } from "node:crypto";
import {
  JobsRepository,
  RebuildsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { buildLogKey } from "../src/common/staging-keys.util.js";

/**
 * **The key must satisfy `build-logs/`.** `verification-svc`'s log route refuses to read any key outside that
 * prefix (`jobs.service.ts`'s `isBuildLogKey`), because the staging bucket also holds submitters' private
 * source tarballs.
 */
let client: PrismaClient;
let jobs: JobsRepository;
let rebuilds: RebuildsRepository;
const createdRows = new CreatedRows();

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  jobs = new JobsRepository(client);
  rebuilds = new RebuildsRepository(client);
});

afterAll(async () => {
  await createdRows.cleanup(client);
  await client.$disconnect();
});
describe("buildLogKey", () => {
  it("★ sits under the prefix verification-svc will actually read", () => {
    expect(buildLogKey("11111111-2222-3333-4444-555555555555", "build")).toBe(
      "build-logs/11111111-2222-3333-4444-555555555555/build.log",
    );
  });

  it("separates a rebuild's two attempts, so a retry cannot overwrite the first", () => {
    // A rebuild may submit two Batch jobs — `verify`, then `build` on the one permitted retry — and the log of
    // the attempt that failed is the one a submitter came for.
    expect(buildLogKey("r", "verify")).not.toBe(buildLogKey("r", "build"));
  });

  it("is rebuild-scoped, never job-scoped", () => {
    // A job-scoped key would leave every deduped job's log route answering 404 forever while the object sat
    // there.
    expect(buildLogKey("rebuild-a", "build")).toBe(buildLogKey("rebuild-a", "build"));
    expect(buildLogKey("rebuild-a", "build")).not.toBe(buildLogKey("rebuild-b", "build"));
  });
});

describe("recordBuildLogKeyForRebuild", () => {
  const IMAGE = `docker.io/example/img@sha256:${"a".repeat(64)}`;

  async function twoJobsOneRebuild() {
    const sourceSha256 = randomBytes(32).toString("hex");
    const sourceRef = {
      type: "source_uri" as const,
      visibility: "public" as const,
      source_uri: "https://example.test/s.tar.gz",
      source_sha256: sourceSha256,
    };
    const rebuildId = createdRows.rebuild(randomUUID());
    await rebuilds.findOrCreate({
      rebuildId,
      idempotencyKey: `build-log-key-${randomBytes(8).toString("hex")}`,
      imageDigest: IMAGE,
      sourceRef,
      buildOptions: { bldopt: [], bldarg: [] },
      buildMode: "verify",
      mechanismReason: "on_chain_recipe_in_trusted_image",
    });

    const ids: string[] = [];
    for (const _ of [0, 1]) {
      const jobId = createdRows.job(randomUUID());
      await jobs.createJob({
        dryRun: false,
        jobId,
        target: { network: "testnet", wasm_hash: randomBytes(32).toString("hex") },
        verificationMode: "submitted",
        imageDigest: IMAGE,
        sourceRef,
        buildOptions: { bldopt: [], bldarg: [] },
        manifest: {
          schema: "stellar-submitted-source-verification-manifest-v1",
          bldimg: IMAGE,
          source_sha256: sourceSha256,
          source_uri: "https://example.test/s.tar.gz",
        } as never,
      });
      await jobs.advanceJob(jobId, "queued", "preparing", { rebuildId });
      ids.push(jobId);
    }
    return { rebuildId, ids };
  }

  /** Terminal, so nothing that scans by status can pick these fixtures up as work. */
  async function park(ids: string[]) {
    for (const jobId of ids) {
      await jobs.advanceJob(jobId, "preparing", "failed", {
        failureReason: "internal_error",
        error: "fixture_teardown",
      });
    }
  }

  it("★ writes the key to every job attached to the rebuild", async () => {
    const { rebuildId, ids } = await twoJobsOneRebuild();
    const key = buildLogKey(rebuildId, "build");

    const updated = await jobs.recordBuildLogKeyForRebuild(rebuildId, key);

    expect(updated).toBe(2);
    for (const jobId of ids) {
      expect((await jobs.getJobById(jobId))?.buildLogObjectKey).toBe(key);
    }
    await park(ids);
  });

  it("touches no job attached to a different rebuild", async () => {
    // `updateMany` with a wrong predicate would stamp the key across the table, and every unrelated job's log
    // route would then serve someone else's build output.
    const mine = await twoJobsOneRebuild();
    const other = await twoJobsOneRebuild();

    await jobs.recordBuildLogKeyForRebuild(mine.rebuildId, buildLogKey(mine.rebuildId, "build"));

    for (const jobId of other.ids) {
      expect((await jobs.getJobById(jobId))?.buildLogObjectKey).toBeUndefined();
    }
    await park([...mine.ids, ...other.ids]);
  });

  it("reports how many rows it touched, so a write that reached nothing is visible", async () => {
    expect(await jobs.recordBuildLogKeyForRebuild(randomUUID(), "build-logs/x/build.log")).toBe(0);
  });
});
