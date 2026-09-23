import { jest } from "@jest/globals";
import type { Server } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { getVerifierIdentity } from "@scvs/config";
import { parseStrictRegistryStatusObject } from "@scvs/core";
import { WasmsService } from "../src/modules/wasms/wasms.service.js";
import { createTestServer } from "./bootstrap.js";

// Filesystem result storage pointing at a per-suite temp dir, set BEFORE the app boots: the config loader
// reads the storage environment once at startup, so the suite has to own it before `createTestServer()`.
let resultsRoot: string;
beforeAll(async () => {
  resultsRoot = await mkdtemp(join(tmpdir(), "wasms-status-"));
  process.env.SCVS_PUBLISHER_STORAGE = "filesystem";
  process.env.SCVS_RESULT_ROOT = resultsRoot;
});

const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

let server: Server;
beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  try {
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
  await rm(resultsRoot, { recursive: true, force: true });
});

const hash = () => randomBytes(32).toString("hex");

/** A job row in `queued` for a wasm hash — the minimal fixture the 202 path needs. */
async function createQueuedJob(wasmHash: string, options: { dryRun?: boolean } = {}): Promise<string> {
  const jobId = createdRows.job(randomUUID());
  await jobsRepository.createJob({
    jobId,
    dryRun: options.dryRun ?? false,
    target: { network: "testnet", wasm_hash: wasmHash },
    verificationMode: "submitted",
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: "https://example.com/wasms-fixture.tar.gz",
      source_sha256: "0".repeat(64),
    } as never,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: "testnet" },
      bldimg: `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`,
      source_sha256: "0".repeat(64),
      source_uri: "https://example.com/wasms-fixture.tar.gz",
    } as never,
  });
  return jobId;
}

/** A realistic published document, written exactly the way the publisher writes it. */
function publishedDocument(wasmHash: string): string {
  const doc = parseStrictRegistryStatusObject({
    schema: "stellar-verification-status",
    schema_version: "1.0",
    wasm_hash: wasmHash,
    updated_at: "2026-08-25T00:00:00.000Z",
    source_code_verifications: [
      {
        verifier: { name: getVerifierIdentity().displayName, url: "https://results.dev.sv.example.com" },
        status: "verified",
        recipe_source: "on_chain_metadata",
        image_trust_level: "sdf_trusted",
        bldimg: `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`,
        source_sha256: "0".repeat(64),
        processed_at: "2026-08-25T00:00:00.000Z",
        results_urls: [
          { type: "report", url: `https://results.dev.sv.example.com/reports/${"a".repeat(64)}.json`, sha256: "a".repeat(64) },
        ],
      },
    ],
  });
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function putPublishedDocument(wasmHash: string, content: string): Promise<void> {
  const dir = join(resultsRoot, "wasms");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${wasmHash}.json`), content, "utf8");
}

describe("GET /api/verification/v1/wasms/:wasm_hash.json", () => {
  it("answers 400 with RC2's restricted set and none of the general envelope's extras", async () => {
    const res = await request(server).get("/api/verification/v1/wasms/not-hex.json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "400_invalid_wasm_hash",
      message: "wasm_hash must be a lowercase-hex SHA-256.",
    });
    // RC2's body is the narrow one: it carries the document's two identifiers and nothing else the general
    // envelope adds.
    expect(res.body.schema).toBe("stellar-verification-error");
    expect(res.body.schema_version).toBe("1.0");
    expect(res.body).not.toHaveProperty("status_code");

    const short = await request(server).get(`/api/verification/v1/wasms/${"a".repeat(63)}.json`);
    expect(short.status).toBe(400);
    expect(short.body.error).toBe("400_invalid_wasm_hash");
  });

  it("answers 404 with the error envelope for a hash with no published record and no in-flight job", async () => {
    const res = await request(server).get(`/api/verification/v1/wasms/${hash()}.json`);
    expect(res.status).toBe(404);
    // SEP §8: every non-2xx body of an API route carries the envelope. The draft this replaced defined no
    // body here, which is why the assertion is on the whole object and not just the code.
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "not_found",
      message: expect.any(String),
    });
    // Same omission as the 400: `status_code` is a property of these routes, not of the document.
    expect(res.body).not.toHaveProperty("status_code");
  });

  it("answers 503 with the error envelope when the storage read fails", async () => {
    // The one arm left: the backend exists and the read throws. An *unreadable configuration* no longer
    // reaches here at all — `resultStorageConfigFromEnv()` throws at boot, which `env-validation.spec.ts`
    // covers. Driven at the service so the suite does not boot a second scheduler.
    const service = new WasmsService(jobsRepository, {
      get: () => ({ kind: "filesystem", root: resultsRoot, publicRoot: "http://localhost:5000/public" }),
    } as never);
    jest
      .spyOn((service as unknown as { storage: { readText: () => Promise<string> } }).storage, "readText")
      .mockRejectedValue(new Error("connection reset"));

    expect(await service.get(hash())).toEqual({
      statusCode: 503,
      body: {
        schema: "stellar-verification-error",
        schema_version: "1.0",
        error: "storage_unavailable",
        message: expect.any(String),
      },
    });
  });

  it("normalises uppercase input the way the submit boundary does", async () => {
    const wasmHash = hash();
    await putPublishedDocument(wasmHash, publishedDocument(wasmHash));

    const res = await request(server).get(`/api/verification/v1/wasms/${wasmHash.toUpperCase()}.json`);
    expect(res.status).toBe(200);
  });

  it("answers 202 with a schema-valid unverified entry while a job is queued", async () => {
    const wasmHash = hash();
    await createQueuedJob(wasmHash);

    const res = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
    expect(res.status).toBe(202);
    const body = res.body;
    // The body validates STRICTLY against the producer shape the publisher writes — AC2's half.
    const parsed = parseStrictRegistryStatusObject(body);
    expect(parsed.wasm_hash).toBe(wasmHash);
    expect(parsed.schema).toBe("stellar-verification-status");
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.updated_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(parsed.source_code_verifications).toHaveLength(1);
    const entry = parsed.source_code_verifications[0];
    expect(entry.verifier.name).toBe(getVerifierIdentity().displayName);
    expect(entry.verifier.url).toEqual(expect.any(String));
    expect(entry.status).toBe("unverified");
    // SO3: an unverified entry is exactly {verifier, status} ON THE WIRE — no processed_at, no custody fields,
    // no recipe.
    expect(Object.keys(res.body.source_code_verifications[0]).sort()).toEqual(["status", "verifier"]);
  });

  it("keeps answering 202 in a running state, and reverts to the tree once the job settles", async () => {
    const wasmHash = hash();
    const jobId = await createQueuedJob(wasmHash);
    await jobsRepository.advanceJob(jobId, "queued", "building");

    const running = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
    expect(running.status).toBe(202);

    await jobsRepository.advanceJob(jobId, "building", "failed");
    const settled = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
    expect(settled.status).toBe(404);
  });

  it("answers 200 with the result root's bytes verbatim for a published hash", async () => {
    const wasmHash = hash();
    const document = publishedDocument(wasmHash);
    await putPublishedDocument(wasmHash, document);

    const res = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    // Byte-identical to the static form — including the publisher's trailing newline.
    expect(res.text).toBe(document);
  });

  it("prefers 202 over a published document while a job is in flight, per RC3's letter", async () => {
    const wasmHash = hash();
    await putPublishedDocument(wasmHash, publishedDocument(wasmHash));
    await createQueuedJob(wasmHash);

    const res = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
    expect(res.status).toBe(202);
  });

  it("includes dry-run jobs in 202: they are verifications submitted through POST, genuinely in flight", async () => {
    const wasmHash = hash();
    await createQueuedJob(wasmHash, { dryRun: true });

    const res = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
    expect(res.status).toBe(202);
  });

  it("creates nothing: any number of GETs leaves the jobs table and the result tree untouched", async () => {
    const wasmHash = hash();
    for (let i = 0; i < 3; i++) {
      const res = await request(server).get(`/api/verification/v1/wasms/${wasmHash}.json`);
      expect(res.status).toBe(404);
    }

    const rows = await prisma.job.count({ where: { wasmHash } });
    expect(rows).toBe(0);
    await expect(access(join(resultsRoot, "wasms", `${wasmHash}.json`))).rejects.toThrow();
  });
});
