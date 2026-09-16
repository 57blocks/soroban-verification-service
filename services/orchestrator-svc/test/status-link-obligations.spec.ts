import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DbModule, JobsRepository, PRISMA_CLIENT, type PrismaClient } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { combineStatusLinkOutcomes } from "../src/modules/publish/status-link-outcome.util.js";

/**
 * The link obligation against real Postgres: what the CHECK refuses, what a retry does to the clock, and
 * which rows the scans see. The link-writing half lives in the storage-layout suites; this is the row.
 */

let jobs: JobsRepository;
let prisma: PrismaClient;
let moduleRef: TestingModule;
const createdRows = new CreatedRows();

const OLD = new Date("2026-01-01T00:00:00Z");

// `rowToJob` parses this back through the DTO, so the scans only see a row whose reference is real.
const sourceRef = {
  type: "git" as const,
  visibility: "public" as const,
  repo: "https://github.com/example/example",
  rev: "a".repeat(40),
  source_sha256: "4".repeat(64),
};

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
    ],
  }).compile();
  jobs = moduleRef.get(JobsRepository);
  prisma = moduleRef.get(PRISMA_CLIENT);
});

afterAll(async () => {
  try {
    if (prisma) await createdRows.cleanup(prisma);
  } finally {
    if (moduleRef) await moduleRef.close();
  }
});

async function publishedJob(): Promise<string> {
  const jobId = createdRows.job(randomUUID());
  await prisma.job.create({
    data: {
      id: jobId,
      network: "testnet",
      verificationMode: "metadata",
      sourceRef,
      buildOptions: {},
      status: "published",
      publishedUpdatedAt: OLD,
      archivePendingSince: OLD,
    },
  });
  return jobId;
}

const read = async (jobId: string) => (await prisma.job.findUnique({ where: { id: jobId } }))!;

describe("a finished upload that still owes a link", () => {
  it("records the tx id and the obligation in one write, so a crash cannot drop either", async () => {
    const jobId = await publishedJob();

    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-1", statusLink: { state: "pending" } });

    const row = await read(jobId);
    expect(row.archivedTxId).toBe("tx-1");
    expect(row.archivePendingSince).toBeNull();
    expect(row.statusLinkPendingSince).not.toBeNull();
  });

  it("does not restart the clock on a retry — the alarm is how long the link has been missing", async () => {
    const jobId = await publishedJob();
    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-1", statusLink: { state: "pending" } });
    await prisma.job.update({ where: { id: jobId }, data: { statusLinkPendingSince: OLD } });

    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-2", statusLink: { state: "pending" } });

    expect((await read(jobId)).statusLinkPendingSince).toEqual(OLD);
  });

  it("clears the obligation and moves the publication clock when the link lands", async () => {
    const jobId = await publishedJob();
    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-1", statusLink: { state: "pending" } });

    await jobs.recordStatusLinkOutcome(jobId, { state: "complete", advancePublished: true });

    const row = await read(jobId);
    expect(row.statusLinkPendingSince).toBeNull();
    expect(row.publishedUpdatedAt!.getTime()).toBeGreaterThan(OLD.getTime());
  });

  it("leaves the publication clock alone when the entry was superseded", async () => {
    const jobId = await publishedJob();
    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-1", statusLink: { state: "pending" } });

    await jobs.recordStatusLinkOutcome(jobId, { state: "complete", advancePublished: false });

    const row = await read(jobId);
    expect(row.statusLinkPendingSince).toBeNull();
    expect(row.publishedUpdatedAt).toEqual(OLD);
  });
});

describe("a job held for a human", () => {
  it("still owes the link, and the scan skips it", async () => {
    const jobId = await publishedJob();
    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-1", statusLink: { state: "pending" } });
    await prisma.job.update({ where: { id: jobId }, data: { statusLinkPendingSince: OLD } });

    await jobs.recordStatusLinkOutcome(jobId, { state: "blocked", reason: "invalid_document" });

    const row = await read(jobId);
    expect(row.statusLinkBlockedReason).toBe("invalid_document");
    expect(row.statusLinkBlockedSince).not.toBeNull();
    expect(row.statusLinkPendingSince).toEqual(OLD);
    expect((await jobs.listJobsPendingStatusLink()).map((j) => j.jobId)).not.toContain(jobId);
  });

  it("returns to the scan with its original clock when the hold is lifted", async () => {
    const jobId = await publishedJob();
    await jobs.recordArchiveOutcome(jobId, { archived: true, txId: "tx-1", statusLink: { state: "pending" } });
    await prisma.job.update({ where: { id: jobId }, data: { statusLinkPendingSince: OLD } });
    await jobs.recordStatusLinkOutcome(jobId, { state: "blocked", reason: "invalid_document" });

    await jobs.clearStatusLinkBlock(jobId);

    const row = await read(jobId);
    expect(row.statusLinkBlockedReason).toBeNull();
    // Not re-stamped: an unblock must not hide how long the link has been owed.
    expect(row.statusLinkPendingSince).toEqual(OLD);
    expect((await jobs.listJobsPendingStatusLink()).map((j) => j.jobId)).toContain(jobId);
  });

  it("cannot be written into an impossible shape", async () => {
    const jobId = await publishedJob();
    // Blocked without owing the link is not a state; the database refuses it rather than trusting the one
    // method that writes these columns to never drift.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "jobs" SET "status_link_blocked_since" = now(), "status_link_blocked_reason" = 'invalid_document' WHERE "id" = '${jobId}'::uuid`,
      ),
    ).rejects.toThrow();
  });
});

describe("retention", () => {
  it("will not prune a job that still owes a link", async () => {
    const jobId = createdRows.job(randomUUID());
    await prisma.job.create({
      data: {
        id: jobId,
        network: "testnet",
        verificationMode: "metadata",
        sourceRef,
        buildOptions: {},
        status: "failed",
        createdAt: OLD,
        statusLinkPendingSince: OLD,
      },
    });

    const prunable = await jobs.listPrunableJobs({ before: new Date(), limit: 100 });
    expect(prunable.map((row) => row.jobId)).not.toContain(jobId);
  });
});

describe("several links, one obligation", () => {
  it("takes the worst outcome, so the row never says nothing is owed while something is", () => {
    expect(combineStatusLinkOutcomes([{ state: "complete", advancePublished: true }, { state: "pending" }]))
      .toEqual({ state: "pending" });
    expect(
      combineStatusLinkOutcomes([{ state: "pending" }, { state: "blocked", reason: "unrepresentable" }]),
    ).toEqual({ state: "blocked", reason: "unrepresentable" });
    expect(
      combineStatusLinkOutcomes([
        { state: "complete", advancePublished: false },
        { state: "complete", advancePublished: true },
      ]),
    ).toEqual({ state: "complete", advancePublished: true });
    // No links left to write is not an obligation to keep scanning.
    expect(combineStatusLinkOutcomes([])).toEqual({ state: "complete", advancePublished: false });
  });
});
