import { randomBytes, randomUUID } from "node:crypto";
import {
  JobsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

let client: PrismaClient;
let jobs: JobsRepository;
const createdRows = new CreatedRows();

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 60_000);

const uniqueKey = () => `build-logs/${randomUUID()}/build.log`;

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  jobs = new JobsRepository(client);
});

afterAll(async () => {
  try {
    await createdRows.cleanup(client);
  } finally {
    await client.$disconnect();
  }
});

async function jobWithLog(opts: {
  key: string;
  expiresAt: Date | null;
  hold?: boolean;
}): Promise<string> {
  const jobId = createdRows.job(randomUUID());
  const sourceSha256 = randomBytes(32).toString("hex");
  await jobs.createJob({
    dryRun: false,
    jobId,
    target: { network: "testnet", wasm_hash: randomBytes(32).toString("hex") },
    verificationMode: "submitted",
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: "https://example.test/s.tar.gz",
      source_sha256: sourceSha256,
    } as never,
    buildOptions: { bldopt: [], bldarg: [] },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      bldimg: `docker.io/example/img@sha256:${"a".repeat(64)}`,
      source_sha256: sourceSha256,
      source_uri: "https://example.test/s.tar.gz",
    } as never,
  });
  await client.job.update({
    where: { id: jobId },
    data: {
      buildLogObjectKey: opts.key,
      buildLogExpiresAt: opts.expiresAt,
      ...(opts.hold ? { buildLogHold: true } : {}),
    },
  });
  return jobId;
}

const ours = (keys: string[], mine: string[]) => keys.filter((key) => mine.includes(key));

describe("listExpiredBuildLogs", () => {
  it("selects an object every one of whose jobs has expired", async () => {
    const key = uniqueKey();
    await jobWithLog({ key, expiresAt: PAST });
    await jobWithLog({ key, expiresAt: PAST });

    const selected = await jobs.listExpiredBuildLogs(new Date(), 500);

    expect(ours(selected, [key])).toEqual([key]);
  });

  it("★ keeps a shared object while ANY job attached to it is still unexpired", async () => {
    const key = uniqueKey();
    await jobWithLog({ key, expiresAt: PAST });
    await jobWithLog({ key, expiresAt: FUTURE });

    const selected = await jobs.listExpiredBuildLogs(new Date(), 500);

    expect(ours(selected, [key])).toEqual([]);
  });

  it("★ a security hold keeps the object, however long expired", async () => {
    const key = uniqueKey();
    await jobWithLog({ key, expiresAt: new Date(0) });
    await jobWithLog({ key, expiresAt: new Date(0), hold: true });

    const selected = await jobs.listExpiredBuildLogs(new Date(), 500);

    expect(ours(selected, [key])).toEqual([]);
  });

  it("leaves a job with no recorded expiry alone — the 30-day job-retention sweep owns those", async () => {
    const key = uniqueKey();
    await jobWithLog({ key, expiresAt: null });

    expect(ours(await jobs.listExpiredBuildLogs(new Date(), 500), [key])).toEqual([]);
  });

  it("returns one entry per object, not one per job", async () => {
    const key = uniqueKey();
    await jobWithLog({ key, expiresAt: PAST });
    await jobWithLog({ key, expiresAt: PAST });
    await jobWithLog({ key, expiresAt: PAST });

    expect(ours(await jobs.listExpiredBuildLogs(new Date(), 500), [key])).toHaveLength(1);
  });
});

describe("clearBuildLogKey", () => {
  it("clears the pointer on every job that shared the object, so a later read is 410 and not a 502", async () => {
    const key = uniqueKey();
    const first = await jobWithLog({ key, expiresAt: PAST });
    const second = await jobWithLog({ key, expiresAt: PAST });

    expect(await jobs.clearBuildLogKey(key)).toBe(2);

    for (const jobId of [first, second]) {
      const row = await jobs.getJobById(jobId);
      expect(row?.buildLogObjectKey).toBeUndefined();
      expect(row?.buildLogExpiresAt).toBeUndefined();
    }
  });
});

describe("countLiveBuildLogClaims", () => {
  it("counts a held or unexpired job and not an expired one", async () => {
    const key = uniqueKey();
    await jobWithLog({ key, expiresAt: PAST });
    await jobWithLog({ key, expiresAt: FUTURE });
    await jobWithLog({ key, expiresAt: new Date(0), hold: true });

    expect(await jobs.countLiveBuildLogClaims(key, new Date())).toBe(2);
  });
});
