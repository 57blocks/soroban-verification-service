import { randomBytes } from "node:crypto";
import {
  SourceArchiveUploadsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

/**
 * `findOrCreate` (packages/db/src/source-archive-uploads.repo.ts) is the concurrency-safety mechanism itself,
 * so.
 */
let clientA: PrismaClient;
let clientB: PrismaClient;
let repoA: SourceArchiveUploadsRepository;
let repoB: SourceArchiveUploadsRepository;
const createdRows = new CreatedRows();

beforeAll(() => {
  const env = readDbEnv();
  clientA = createPrismaClient(env);
  clientB = createPrismaClient(env);
  repoA = new SourceArchiveUploadsRepository(clientA);
  repoB = new SourceArchiveUploadsRepository(clientB);
});

afterAll(async () => {
  await createdRows.cleanup(clientA);
  await clientA.$disconnect();
  await clientB.$disconnect();
});

function freshSha256(): string {
  return createdRows.sourceArchiveUpload(randomBytes(32).toString("hex"));
}

describe("SourceArchiveUploadsRepository", () => {
  it("findOrCreate claims an unclaimed hash", async () => {
    const sha = freshSha256();
    const { record, won } = await repoA.findOrCreate(sha);
    expect(won).toBe(true);
    expect(record.status).toBe("claimed");
  });

  it("findOrCreate on an already-done hash returns it without a new claim", async () => {
    const sha = freshSha256();
    await repoA.findOrCreate(sha);
    await repoA.markDone(sha, "tx-1");

    const { record, won } = await repoB.findOrCreate(sha);
    expect(won).toBe(false);
    expect(record.status).toBe("done");
    expect(record.txId).toBe("tx-1");
  });

  it("releaseClaim reopens a claimed row for a fresh claim", async () => {
    const sha = freshSha256();
    await repoA.findOrCreate(sha);
    await repoA.releaseClaim(sha);

    const { record, won } = await repoB.findOrCreate(sha);
    expect(won).toBe(true);
    expect(record.status).toBe("claimed");
  });

  it("releaseClaim against a done row deletes nothing", async () => {
    const sha = freshSha256();
    await repoA.findOrCreate(sha);
    await repoA.markDone(sha, "tx-2");

    await repoA.releaseClaim(sha);

    const record = await repoB.getBySourceSha256(sha);
    expect(record?.status).toBe("done");
    expect(record?.txId).toBe("tx-2");
  });

  it("two independent connections racing findOrCreate produce exactly one winner", async () => {
    const sha = freshSha256();
    const [a, b] = await Promise.all([repoA.findOrCreate(sha), repoB.findOrCreate(sha)]);

    const winners = [a, b].filter((result) => result.won);
    expect(winners).toHaveLength(1);
    expect(a.record.sourceSha256).toBe(b.record.sourceSha256);
  });
});
