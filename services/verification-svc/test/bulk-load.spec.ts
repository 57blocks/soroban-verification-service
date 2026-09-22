import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { createTestServer } from "./bootstrap.js";

// Same pattern as jobs.spec.ts: this route does nothing but a keyset read over `jobs`, so it is exercised
// against the real local Postgres rather than a mocked JobsRepository.
const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

// Distinct prefix so this suite's rows never collide with a concurrently running sibling's, and so `wasmHash: {
// not: null }` in `listPublished` never picks up unrelated jobs sharing this process's Postgres.
const HASHES = ["1", "2"].map((prefix) => prefix.repeat(64));

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
});

/** A job that reached `published` with a given `wasmHash`/`publishedUpdatedAt`, or neither. */
async function createPublishedJob(input: { wasmHash: string; publishedUpdatedAt?: string }): Promise<string> {
  const jobId = createdRows.job(randomUUID());
  await jobsRepository.createJob({
    dryRun: false,
    jobId,
    target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
    verificationMode: "submitted",
    sourceRef: { type: "source_uri", visibility: "public", source_uri: "https://example.com/fake.tar.gz", source_sha256: "0".repeat(64) } as any,
    buildOptions: {},
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
      bldimg: "docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43",
      source_sha256: "0".repeat(64),
      source_uri: "https://example.com/fake.tar.gz",
    } as any,
  });
  await jobsRepository.advanceJob(jobId, "queued", "published", {
    verdict: "verified",
    wasmHash: input.wasmHash,
    ...(input.publishedUpdatedAt ? { publishedUpdatedAt: new Date(input.publishedUpdatedAt) } : {}),
  });
  return jobId;
}

describe("GET /api/verification/v1/wasms — BL1's stream, verification-svc's own", () => {
  it("rejects a malformed cursor, order or limit instead of quietly defaulting", async () => {
    for (const [query, error] of [
      ["order=sideways", "invalid_order"],
      ["limit=0", "invalid_limit"],
      ["limit=201", "invalid_limit"],
      ["cursor=nonsense", "invalid_cursor"],
    ] as const) {
      const res = await request(server).get(`/api/verification/v1/wasms?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
    }
  });

  it("pages by keyset, and two records sharing a millisecond both come through (BL2)", async () => {
    // The case a timestamp-only cursor drops one of.
    const at = "2026-06-30T00:00:00.000Z";
    for (const wasmHash of HASHES) await createPublishedJob({ wasmHash, publishedUpdatedAt: at });

    const first = await request(server).get("/api/verification/v1/wasms?limit=1&order=asc");
    expect(first.status).toBe(200);
    expect(first.body.records).toHaveLength(1);
    expect(first.body.cursor).not.toBeNull();

    const second = await request(server).get(`/api/verification/v1/wasms?limit=1&cursor=${first.body.cursor}`);
    const seen = [...first.body.records, ...second.body.records].map((record: { wasm_hash: string }) => record.wasm_hash);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(HASHES));
  });

  it("a page shorter than the requested limit is the end of the stream (BL4)", async () => {
    const publishedUpdatedAt = "2040-01-01T00:00:00.000Z";
    const wasmHash = `${"3".repeat(63)}c`;
    await createPublishedJob({ wasmHash, publishedUpdatedAt });

    const res = await request(server).get(
      `/api/verification/v1/wasms?limit=200&order=asc&cursor=${new Date("2039-01-01T00:00:00.000Z").getTime()}-${"0".repeat(64)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.records.map((r: { wasm_hash: string }) => r.wasm_hash)).toEqual([wasmHash]);
    expect(res.body.cursor).toBeNull();
  });

  it("excludes a job that has never published (published_updated_at IS NULL)", async () => {
    const neverPublished = createdRows.job(randomUUID());
    await jobsRepository.createJob({
      dryRun: false,
      jobId: neverPublished,
      target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
      verificationMode: "submitted",
      sourceRef: { type: "source_uri", visibility: "public", source_uri: "https://example.com/fake.tar.gz", source_sha256: "0".repeat(64) } as any,
      buildOptions: {},
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        target: { network: "testnet", contract_id: "CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG" },
        bldimg: "docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43",
        source_sha256: "0".repeat(64),
        source_uri: "https://example.com/fake.tar.gz",
      } as any,
    });
    // Still `queued` — never reached `published`, so `publishedUpdatedAt` was never set.

    const res = await request(server).get("/api/verification/v1/wasms?limit=200");
    expect(res.status).toBe(200);
    expect(res.body.records.map((r: { wasm_hash: string }) => r.wasm_hash)).not.toContain(undefined);
  });

  it(
    "excludes a `published` row left with published_updated_at NULL by ADR-014's no-op overwrite " +
      "— this is not corrupt data, it just isn't the authoritative record for that hash",
    async () => {
      // A job that reached `published` (e.g. a losing `mismatched` verdict for an already-`verified` hash) but
      // whose publish attempt was a no-op overwrite (publish.service.ts's `isNoOpOverwrite`) never advances
      // `publishedUpdatedAt`.
      const noOpHash = `${"9".repeat(63)}a`;
      const noOpJob = await createPublishedJob({ wasmHash: noOpHash }); // no publishedUpdatedAt

      const res = await request(server).get("/api/verification/v1/wasms?limit=200");
      expect(res.status).toBe(200);
      expect(res.body.records.map((r: { wasm_hash: string }) => r.wasm_hash)).not.toContain(noOpHash);

      // The row is real and published — just not this hash's bulk-load-eligible record.
      const row = await prisma.job.findUniqueOrThrow({ where: { id: noOpJob } });
      expect(row.status).toBe("published");
      expect(row.publishedUpdatedAt).toBeNull();
    },
  );

  it("carries the job's own published_updated_at, not the time of this request", async () => {
    const wasmHash = `${"7".repeat(63)}b`;
    await createPublishedJob({ wasmHash, publishedUpdatedAt: "2026-06-30T00:00:00.000Z" });

    const res = await request(server).get("/api/verification/v1/wasms?limit=200");
    const record = res.body.records.find((r: { wasm_hash: string }) => r.wasm_hash === wasmHash);
    expect(record.updated_at).toBe("2026-06-30T00:00:00.000Z");
  });

  it("re-delivers a hash after its publication update advances, and a mirror upserts it (BL1/BL5)", async () => {
    const wasmHash = `${"8".repeat(63)}d`;
    const initialUpdatedAt = "2099-01-01T00:00:00.000Z";
    const recoveredUpdatedAt = "2099-01-01T00:00:01.000Z";
    const jobId = await createPublishedJob({ wasmHash, publishedUpdatedAt: initialUpdatedAt });

    const initial = await request(server).get(
      `/api/verification/v1/wasms?limit=200&order=asc&cursor=${new Date("2098-12-31T23:59:59.999Z").getTime()}-${"0".repeat(64)}`,
    );
    expect(initial.status).toBe(200);
    expect(initial.body.records).toContainEqual({ wasm_hash: wasmHash, updated_at: initialUpdatedAt });

    await prisma.job.update({ where: { id: jobId }, data: { publishedUpdatedAt: new Date(recoveredUpdatedAt) } });

    const redelivered = await request(server).get(
      `/api/verification/v1/wasms?limit=200&order=asc&cursor=${new Date(initialUpdatedAt).getTime()}-${wasmHash}`,
    );
    expect(redelivered.status).toBe(200);
    const updated = redelivered.body.records.find((record: { wasm_hash: string }) => record.wasm_hash === wasmHash);
    expect(updated).toEqual({ wasm_hash: wasmHash, updated_at: recoveredUpdatedAt });

    const mirror = new Map<string, { updated_at: string }>();
    mirror.set(wasmHash, { updated_at: initialUpdatedAt });
    mirror.set(updated.wasm_hash, { updated_at: updated.updated_at });
    expect(mirror).toEqual(new Map([[wasmHash, { updated_at: recoveredUpdatedAt }]]));
  });

  it("names its document type, so a page identifies itself away from the route that served it", async () => {
    const res = await request(server).get("/api/verification/v1/wasms?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.schema).toBe("stellar-verification-page");
    expect(res.body.schema_version).toBe("1.0");
  });
});

describe("GET /api/verification/v1/wasms.json — the deprecated spelling", () => {
  // A sibling suite re-stamps `published_updated_at` on a row it already published (`recordArchiveOutcome`,
  // `recordStatusLinkOutcome`), so both routes are asked for a one-row window opened 1 ms below a row this file
  // created. `f`×64 is above every hex hash, so nothing sharing that lower bound's millisecond slips in.
  const windowFrom = (at: string) => `order=asc&limit=1&cursor=${new Date(at).getTime() - 1}-${"f".repeat(64)}`;

  it("answers what the canonical route answers, and says it is deprecated", async () => {
    const publishedUpdatedAt = "2097-06-30T00:00:00.000Z";
    const wasmHash = `${"6".repeat(63)}c`;
    await createPublishedJob({ wasmHash, publishedUpdatedAt });
    const query = windowFrom(publishedUpdatedAt);

    const canonical = await request(server).get(`/api/verification/v1/wasms?${query}`);
    const alias = await request(server).get(`/api/verification/v1/wasms.json?${query}`);

    // Spelled out, so the equality below can never hold by both routes answering an empty page.
    expect(canonical.status).toBe(200);
    expect(canonical.body).toEqual({
      schema: "stellar-verification-page",
      schema_version: "1.0",
      order: "asc",
      cursor: `${new Date(publishedUpdatedAt).getTime()}-${wasmHash}`,
      records: [{ wasm_hash: wasmHash, updated_at: publishedUpdatedAt }],
    });

    expect(alias.status).toBe(200);
    expect(alias.body).toEqual(canonical.body);
    expect(alias.headers.deprecation).toBe("true");
    expect(alias.headers.sunset).toBe("Mon, 01 Dec 2026 00:00:00 GMT");
  });

  it("shares one cursor space with the canonical route, so a consumer can migrate mid-stream", async () => {
    // One pair on one timestamp: the handover only proves something if the canonical route resolves the same
    // wasm_hash tiebreak the deprecated route's cursor encoded.
    const publishedUpdatedAt = "2097-07-01T00:00:00.000Z";
    const hashes = [`${"6".repeat(63)}d`, `${"6".repeat(63)}e`];
    for (const wasmHash of hashes) await createPublishedJob({ wasmHash, publishedUpdatedAt });

    const first = await request(server).get(`/api/verification/v1/wasms.json?${windowFrom(publishedUpdatedAt)}`);
    expect(first.status).toBe(200);
    expect(first.body.records).toEqual([{ wasm_hash: hashes[0], updated_at: publishedUpdatedAt }]);
    expect(first.body.cursor).toBe(`${new Date(publishedUpdatedAt).getTime()}-${hashes[0]}`);

    const second = await request(server).get(`/api/verification/v1/wasms?limit=1&cursor=${first.body.cursor}`);
    expect(second.status).toBe(200);
    expect(second.body.records).toEqual([{ wasm_hash: hashes[1], updated_at: publishedUpdatedAt }]);
  });
});
