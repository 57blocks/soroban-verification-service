import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createTestApp } from "./bootstrap.js";

const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

let app: NestExpressApplication;
let server: Server;
beforeAll(async () => {
  app = await createTestApp();
  server = app.getHttpServer();
});

afterAll(async () => {
  try {
    await app?.close();
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"d".repeat(64)}`;

function submission(dryRun?: boolean) {
  return {
    target: { network: "testnet", contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}` },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      bldimg: IMAGE,
      source_sha256: randomBytes(32).toString("hex"),
      source_uri: "https://example.com/dry-run-fixture.tar.gz",
    },
    ...(dryRun === undefined ? {} : { dry_run: dryRun }),
  };
}

async function submit(body: object): Promise<request.Response> {
  const res = await request(server).post("/api/verification/v1/verifications").send(body);
  createdRows.job(res.body?.job_id);
  return res;
}

describe("dry_run", () => {
  it("honours a dry run: accepts it, and persists dry_run true", async () => {
    const body = submission(true);
    const res = await submit(body);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.job_id).toBeDefined();

    const job = await jobsRepository.getJobById(res.body.job_id);
    expect(job?.dryRun).toBe(true);
    // Scoped to this submission's contract id, not a table count: the suites share one Postgres.
    expect(await prisma.job.count({ where: { contractId: body.target.contract_id } })).toBe(1);
  });

  it("no longer answers 501 for it", async () => {
    const res = await submit(submission(true));
    expect(res.status).not.toBe(501);
  });

  it("accepts a submission that does not ask for one, and persists dry_run false", async () => {
    const res = await submit(submission());
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");

    const job = await jobsRepository.getJobById(res.body.job_id);
    expect(job?.dryRun).toBe(false);
  });

  it("accepts an explicit dry_run: false", async () => {
    const res = await submit(submission(false));
    expect(res.status).toBe(202);

    const job = await jobsRepository.getJobById(res.body.job_id);
    expect(job?.dryRun).toBe(false);
  });

  it("never answers a real submission with a dry run's job, or the reverse", async () => {
    const contract = `C${randomBytes(20).toString("hex").toUpperCase()}`;
    const fixture = submission();
    const sameTarget = () => ({
      ...fixture,
      target: { network: "testnet", contract_id: contract },
    });

    const dry = await submit({ ...sameTarget(), dry_run: true });
    expect(dry.status).toBe(202);

    const real = await submit(sameTarget());
    expect(real.status).toBe(202);
    expect(real.body.job_id).not.toBe(dry.body.job_id);
    expect((await jobsRepository.getJobById(real.body.job_id))?.dryRun).toBe(false);

    const dryAgain = await submit({ ...sameTarget(), dry_run: true });
    expect(dryAgain.body.job_id).toBe(dry.body.job_id);
  });

  it("rejects a non-boolean dry_run as a validation error", async () => {
    const res = await submit({ ...submission(), dry_run: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});
