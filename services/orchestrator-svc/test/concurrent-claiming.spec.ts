import { randomBytes, randomUUID } from "node:crypto";
import { JobsRepository, createPrismaClient, readDbEnv, type PrismaClient } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

/** **T12 — concurrent claiming (DB1).** "Two instances never dispatch the same job." */
const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`;

let clientA: PrismaClient;
let clientB: PrismaClient;
let repoA: JobsRepository;
let repoB: JobsRepository;
const createdRows = new CreatedRows();

beforeAll(() => {
  const env = readDbEnv();
  clientA = createPrismaClient(env);
  clientB = createPrismaClient(env);
  repoA = new JobsRepository(clientA);
  repoB = new JobsRepository(clientB);
});

afterAll(async () => {
  await createdRows.cleanup(clientA);
  await clientA.$disconnect();
  await clientB.$disconnect();
});

async function seedQueuedJob(): Promise<string> {
  const jobId = createdRows.job(randomUUID());
  const sourceSha256 = randomBytes(32).toString("hex");
  await repoA.createJob({
    jobId,
    target: { network: "testnet", contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}` },
    verificationMode: "submitted",
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: "https://example.com/t12.tar.gz",
      source_sha256: sourceSha256,
    },
    buildOptions: { bldopt: [], bldarg: [] },
    dryRun: false,
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      bldimg: IMAGE,
      source_sha256: sourceSha256,
      source_uri: "https://example.com/t12.tar.gz",
    } as never,
  });
  return jobId;
}

describe("T12 — two instances never claim the same job (DB1)", () => {
  it.each([
    ["queued", "preparing"],
    ["building", "comparing"],
    ["comparing", "publishing"],
  ] as const)(
    "exactly one instance wins %s -> %s",
    async (from, to) => {
      const jobId = await seedQueuedJob();
      if (from !== "queued") {
        // Walk the row to the state under test through the same conditional writes, so the setup cannot
        // accidentally prove something the production path would not do.
        const path = ["queued", "preparing", "building", "comparing"] as const;
        for (let i = 1; i <= path.indexOf(from); i += 1) {
          expect(await repoA.advanceJob(jobId, path[i - 1]!, path[i]!)).toBe(true);
        }
      }

      // Both instances reach for the same row in the same moment.
      const [wonByA, wonByB] = await Promise.all([
        repoA.advanceJob(jobId, from, to),
        repoB.advanceJob(jobId, from, to),
      ]);

      expect([wonByA, wonByB].filter(Boolean)).toHaveLength(1);
      expect((await repoA.getJobById(jobId))?.status).toBe(to);

      // And the loser stays a loser: a second attempt from the state it thought it was in still matches
      // nothing, so a retry cannot turn one claim into two.
      expect(await repoB.advanceJob(jobId, from, to)).toBe(false);
    },
  );

  it("a job re-queued by Rule D is claimed once, not once per instance", async () => {
    // A version that re-queued straight to `preparing` would hand the job to whichever replica ran the scan.
    const jobId = await seedQueuedJob();
    expect(await repoA.advanceJob(jobId, "queued", "failed", { failureReason: "internal_error" })).toBe(true);

    const requeued = await repoA.requeueRetryableFailures(3, new Date(Date.now() - 60 * 60_000), [jobId]);
    expect(requeued).toContain(jobId);
    expect((await repoB.getJobById(jobId))?.status).toBe("queued");

    const [a, b] = await Promise.all([
      repoA.advanceJob(jobId, "queued", "preparing"),
      repoB.advanceJob(jobId, "queued", "preparing"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("two scans racing the same publish_pending job produce one claim (T11)", async () => {
    const jobId = await seedQueuedJob();
    expect(
      await repoA.advanceJob(jobId, "queued", "publish_pending", { verdict: "verified" }),
    ).toBe(true);

    const [a, b] = await Promise.all([repoA.claimForPublish(jobId), repoB.claimForPublish(jobId)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await repoA.getJobById(jobId))?.status).toBe("publishing");
  });

  it("releases a job whose worker died mid-publication, and only once it is actually stale (T11)", async () => {
    const jobId = await seedQueuedJob();
    expect(await repoA.advanceJob(jobId, "queued", "publishing", { verdict: "verified" })).toBe(true);

    // Fresh: a healthy publish in flight must not be taken away from the worker doing it.
    expect(await repoA.releaseStalePublishing(new Date(Date.now() - 60_000), [jobId])).toEqual([]);
    expect((await repoA.getJobById(jobId))?.status).toBe("publishing");

    // Stale: the worker is gone, and nothing else would ever move this row — `publishing` is the one
    // non-terminal state outside the dispatch poll loop.
    await clientA.$executeRawUnsafe(
      `UPDATE jobs SET updated_at = now() - interval '1 hour' WHERE id = $1::uuid`,
      jobId,
    );
    expect(await repoA.releaseStalePublishing(new Date(Date.now() - 60_000), [jobId])).toContain(jobId);
    expect((await repoB.getJobById(jobId))?.status).toBe("publish_pending");
  });
});
