import { jest } from "@jest/globals";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AggregationRepository, TrustedVerifiersRepository, createPrismaClient, readDbEnv } from "@scvs/db-query";
import { AggregationSyncService } from "../src/modules/aggregation/aggregation-sync.service.js";

// Set before bootstrap.js is imported: the pinned transport bypasses the `globalThis.fetch` stub.
process.env.SCVS_QUERY_PIN_DNS_RESOLUTION = "false";

const { createTestApp } = await import("./bootstrap.js");

const prisma = createPrismaClient(readDbEnv());
const aggregation = new AggregationRepository(prisma);
const trustedVerifiers = new TrustedVerifiersRepository(prisma);

const HASHES = ["a", "b", "c", "d"].map((prefix) => prefix.repeat(64));
const VERIFIER_A = "spec-verifier-a";
const VERIFIER_B = "spec-verifier-b";

let app: NestExpressApplication;

/** `trusted_verifiers` holds rows this suite does not own, such as a seeded `local-verifier`. */
const oursOnly = (unavailable: { url: string }[]): { url: string }[] =>
  unavailable.filter(({ url }) => url.includes(".test/"));

const entry = (status: string) => ({
  status,
  recipe: { bldimg: `docker.io/x/y@sha256:${"c".repeat(64)}` },
  processedAt: "2026-06-30T00:00:00.000Z",
});

beforeAll(async () => {
  // Connect inside the lifecycle: Prisma loads its engine lazily, and Jest refuses an import between tests.
  await prisma.$connect();
  app = await createTestApp();
});

afterEach(async () => {
  await prisma.verificationResult.deleteMany({ where: { verifierId: { in: [VERIFIER_A, VERIFIER_B] } } });
  await prisma.aggregatedWasmIndex.deleteMany({ where: { wasmHash: { in: HASHES } } });
  await prisma.verifierSyncCursor.deleteMany({ where: { verifierId: { in: [VERIFIER_A, VERIFIER_B] } } });
  await prisma.trustedVerifier.deleteMany({ where: { verifierId: { in: [VERIFIER_A, VERIFIER_B] } } });
});

afterAll(async () => {
  try {
    await app.close();
  } finally {
    await prisma.$disconnect();
  }
});

describe("AB2 — the aggregation key moves on a change, and only on a change", () => {
  it("advances when an entry appears, holds still when an identical one is re-read", async () => {
    const [hash] = HASHES;
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });
    const [first] = await aggregation.listAggregationIndex({ order: "asc", limit: 10 });
    expect(first.wasmHash).toBe(hash);

    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T01:00:00.000Z",
      now: "2026-06-30T01:00:00.000Z",
    });
    const [unchanged] = await aggregation.listAggregationIndex({ order: "asc", limit: 10 });
    expect(unchanged.aggregationUpdatedAt).toBe(first.aggregationUpdatedAt);

    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("mismatched"),
      retrievedAt: "2026-06-30T02:00:00.000Z",
      now: "2026-06-30T02:00:00.000Z",
    });
    const [changed] = await aggregation.listAggregationIndex({ order: "asc", limit: 10 });
    expect(new Date(changed.aggregationUpdatedAt).getTime()).toBeGreaterThan(
      new Date(first.aggregationUpdatedAt).getTime(),
    );
  });

  it("withdraws a retracted entry rather than serving a claim the verifier took back", async () => {
    const [hash] = HASHES;
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });
    await aggregation.withdrawVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      now: "2026-06-30T03:00:00.000Z",
    });

    expect(await aggregation.listCachedEntriesForHash(hash)).toEqual([]);
    expect(await aggregation.listAggregationIndex({ order: "asc", limit: 10 })).toEqual([]);
  });
});

describe("GET /api/query/v1/wasms", () => {
  it("refuses until the first sync pass has completed, rather than serving an empty stream", async () => {
    const res = await request(app.getHttpServer()).get("/api/query/v1/wasms");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("aggregation_unavailable");
  });

  it("rejects a malformed cursor, order or limit instead of quietly defaulting", async () => {
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;
    for (const [query, error] of [
      ["order=sideways", "invalid_order"],
      ["limit=0", "invalid_limit"],
      ["limit=201", "invalid_limit"],
      ["cursor=nonsense", "invalid_cursor"],
    ] as const) {
      const res = await request(app.getHttpServer()).get(
        `/api/query/v1/wasms?${query}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
      expect(res.body.schema).toBe("stellar-verification-error");
      expect(res.body.schema_version).toBe("1.0");
      expect(typeof res.body.message).toBe("string");
    }
  });

  it("serializes aggregationUpdatedAt in the cursor, not a peer's processed_at", async () => {
    const [hash] = HASHES;
    const aggregatedAt = "2500-01-02T03:04:05.000Z";
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: { ...entry("verified"), processedAt: "2600-12-31T23:59:59.000Z" },
      retrievedAt: "2500-01-02T03:04:06.000Z",
      now: aggregatedAt,
    });
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;

    const res = await request(app.getHttpServer()).get("/api/query/v1/wasms?order=desc&limit=1");
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].wasm_hash).toBe(hash);
    expect(res.body.cursor).toBe(`${Date.parse(aggregatedAt)}-${hash}`);
    expect(res.body.schema).toBe("stellar-verification-page");
    expect(res.body.schema_version).toBe("1.0");
  });
});

describe("the deprecated `.json` route spellings", () => {
  it("answers the per-hash route identically, and does not let `.json` leak into the hash", async () => {
    const [hash] = HASHES;
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });

    const canonical = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    const alias = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}.json`);

    expect(alias.status).toBe(200);
    const { updated_at: _aliasAt, ...aliasBody } = alias.body;
    const { updated_at: _canonicalAt, ...canonicalBody } = canonical.body;
    expect(aliasBody).toEqual(canonicalBody);
    expect(alias.body.source_code_verifications).toHaveLength(1);
    expect(alias.headers.deprecation).toBe("true");
    expect(alias.headers.sunset).toBe("Mon, 01 Dec 2026 00:00:00 GMT");
  });

  it("answers the bulk route identically", async () => {
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;
    const canonical = await request(app.getHttpServer()).get("/api/query/v1/wasms?order=desc&limit=1");
    const alias = await request(app.getHttpServer()).get("/api/query/v1/wasms.json?order=desc&limit=1");

    expect(alias.status).toBe(200);
    expect(alias.body.schema).toBe("stellar-verification-page");
    expect(alias.body.order).toBe(canonical.body.order);
    expect(alias.headers.deprecation).toBe("true");
    expect(alias.headers.sunset).toBe("Mon, 01 Dec 2026 00:00:00 GMT");
  });
});

describe("GET /api/query/v1/wasms/:wasm_hash", () => {
  it("carries every verifier's entry, its retrieval time, and a descriptive agreement", async () => {
    const [hash] = HASHES;
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });

    const single = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(single.status).toBe(200);
    expect(single.body.schema_version).toBe("1.0");
    expect(single.body.source_code_verifications).toHaveLength(1);
    expect(single.body.source_code_verifications[0].retrieved_at).toBe("2026-06-30T00:00:00.000Z");
    expect(single.body.agreement).toBe("single");

    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_B,
      wasmHash: hash,
      entry: entry("mismatched"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });

    const both = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(both.body.source_code_verifications).toHaveLength(2);
    expect(both.body.agreement).toBe("disputed");
  });

  it("refuses before the first sync pass instead of answering no_data, which would be a third fact", async () => {
    const sync = app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean };
    sync.firstPassComplete = false;
    try {
      for (const path of [
        `/api/query/v1/wasms/${HASHES[2]}`,
        `/api/query/v1/wasms/${HASHES[2]}.json`,
        "/api/query/v1/contracts/mainnet/CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
      ]) {
        const res = await request(app.getHttpServer()).get(path);
        expect([path, res.status]).toEqual([path, 503]);
        expect(res.body.error).toBe("aggregation_unavailable");
      }
    } finally {
      sync.firstPassComplete = true;
    }
  });

  it("distinguishes 'nobody has a result' from 'we could not reach some'", async () => {
    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${HASHES[2]}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications).toEqual([]);
    expect(oursOnly(res.body.unavailable_verifiers)).toEqual([]);
    expect(res.body.agreement).toBe("no_data");
  });

  it("serves retained peer evidence while naming the peer's failed sync", async () => {
    const [hash] = HASHES;
    await Promise.all(
      [VERIFIER_A, VERIFIER_B].map((verifierId) =>
        trustedVerifiers.upsertTrustedVerifier({
          verifierId,
          manifestUrl: `https://${verifierId}.spec.test/verifier-manifest.json`,
          resultsRoot: `https://${verifierId}.spec.test/`,
          bulkLoadUrl: `https://${verifierId}.spec.test/api/verification/v1/wasms`,
        }),
      ),
    );
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_A,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });
    await aggregation.recordVerifierEntry({
      verifierId: VERIFIER_B,
      wasmHash: hash,
      entry: entry("verified"),
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });
    await aggregation.setCursor(VERIFIER_B, undefined, "connection refused");

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications).toHaveLength(2);
    const retainedPeer = res.body.source_code_verifications.find(
      (entry: { verifier: { url: string } }) => entry.verifier.url === `https://${VERIFIER_B}.spec.test/`,
    );
    expect(retainedPeer.retrieved_at).toBe("2026-06-30T00:00:00.000Z");
    expect(oursOnly(res.body.unavailable_verifiers)).toEqual([
      expect.objectContaining({ url: `https://${VERIFIER_B}.spec.test/`, reason: "fetch_failed" }),
    ]);
    expect(res.body).not.toHaveProperty("global_verdict");
  });
});

describe("the aggregate relays the peer's own identity, keyed by result root", () => {
  const seed = (verifierId: string, extra: { displayName?: string; status?: string } = {}) =>
    trustedVerifiers.upsertTrustedVerifier({
      verifierId,
      manifestUrl: `https://${verifierId}.spec.test/verifier-manifest.json`,
      resultsRoot: `https://${verifierId}.spec.test/`,
      bulkLoadUrl: `https://${verifierId}.spec.test/api/verification/v1/wasms`,
      ...extra,
    });

  const record = (verifierId: string, wasmHash: string, verifier?: { url?: string; name?: string }) =>
    aggregation.recordVerifierEntry({
      verifierId,
      wasmHash,
      entry: {
        ...entry("verified"),
        ...(verifier !== undefined ? { verifier } : {}),
      },
      retrievedAt: "2026-06-30T00:00:00.000Z",
      now: "2026-06-30T00:00:00.000Z",
    });

  it("serves the peer's own name and url, not the operator's label", async () => {
    const [hash] = HASHES;
    await seed(VERIFIER_A, { displayName: "What Our Operator Calls Them" });
    await record(VERIFIER_A, hash, { url: `https://${VERIFIER_A}.spec.test/`, name: "What They Call Themselves" });

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    const [served] = res.body.source_code_verifications;
    expect(served.verifier).toEqual({ url: `https://${VERIFIER_A}.spec.test/`, name: "What They Call Themselves" });
    expect(served).not.toHaveProperty("verifier_id");
    expect(served).not.toHaveProperty("published_verifier");
  });

  it("falls back to the result root we read it from when a retained row has no verifier block", async () => {
    const [hash] = HASHES;
    await seed(VERIFIER_A, { displayName: "Irrelevant Here" });
    await record(VERIFIER_A, hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications[0].verifier.url).toBe(`https://${VERIFIER_A}.spec.test/`);
  });

  it("names an unreachable verifier by result root too, so both lists line up on one field", async () => {
    const [hash] = HASHES;
    await seed(VERIFIER_A, { displayName: "Verifier A" });
    await seed(VERIFIER_B, { displayName: "Verifier B" });
    await record(VERIFIER_A, hash, { url: `https://${VERIFIER_A}.spec.test/` });
    await record(VERIFIER_B, hash, { url: `https://${VERIFIER_B}.spec.test/` });
    await aggregation.setCursor(VERIFIER_B, undefined, "connection refused");

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(oursOnly(res.body.unavailable_verifiers)).toEqual([
      expect.objectContaining({ url: `https://${VERIFIER_B}.spec.test/`, name: "Verifier B", reason: "fetch_failed" }),
    ]);
    expect(oursOnly(res.body.unavailable_verifiers)[0]).not.toHaveProperty("verifier_id");
  });

  it("still serves a paused member's retained entry, and still keeps it out of unavailable", async () => {
    const [hash] = HASHES;
    await seed(VERIFIER_A, { displayName: "Paused But Still Cached", status: "paused" });
    await record(VERIFIER_A, hash, { url: `https://${VERIFIER_A}.spec.test/`, name: "Paused Peer" });
    await aggregation.setCursor(VERIFIER_A, undefined, "connection refused");

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications[0].verifier.name).toBe("Paused Peer");
    expect(oursOnly(res.body.unavailable_verifiers)).toEqual([]);
  });

  it("neither serves nor counts a disabled member's retained entry, on either route", async () => {
    const [hash] = HASHES;
    await seed(VERIFIER_A, { status: "disabled" });
    await seed(VERIFIER_B);
    await record(VERIFIER_A, hash, { url: `https://${VERIFIER_A}.spec.test/` });
    await record(VERIFIER_B, hash, { url: `https://${VERIFIER_B}.spec.test/` });

    const single = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(single.status).toBe(200);
    expect(single.body.source_code_verifications.map((served: { verifier: { url: string } }) => served.verifier.url)).toEqual([
      `https://${VERIFIER_B}.spec.test/`,
    ]);

    const stream = await request(app.getHttpServer()).get("/api/query/v1/wasms?limit=100");
    const streamed = stream.body.records.find((candidate: { wasm_hash: string }) => candidate.wasm_hash === hash);
    expect(streamed.source_code_verifications).toHaveLength(1);
    expect(streamed.source_code_verifications[0].verifier.url).toBe(`https://${VERIFIER_B}.spec.test/`);
  });

  it("withdraws a disabled member's cache on sync, re-timing the hash and resetting its cursor", async () => {
    const [hash, pausedHash] = HASHES;
    await seed(VERIFIER_A, { status: "disabled" });
    await seed(VERIFIER_B, { status: "paused" });
    await record(VERIFIER_A, hash);
    await record(VERIFIER_B, hash);
    await record(VERIFIER_B, pausedHash);
    await aggregation.setCursor(VERIFIER_A, "cursor-before-disabling");
    const [before] = (await aggregation.listAggregationIndex({ order: "asc", limit: 100 })).filter(
      (row) => row.wasmHash === hash,
    );

    await app.get(AggregationSyncService).withdrawDisabled();

    expect((await aggregation.listCachedEntriesForHash(hash)).map((row) => row.verifierId)).toEqual([VERIFIER_B]);
    expect(await aggregation.listCachedEntriesForHash(pausedHash)).toHaveLength(1);
    const [after] = (await aggregation.listAggregationIndex({ order: "asc", limit: 100 })).filter(
      (row) => row.wasmHash === hash,
    );
    expect(new Date(after.aggregationUpdatedAt).getTime()).toBeGreaterThan(new Date(before.aggregationUpdatedAt).getTime());
    expect(await aggregation.getCursor(VERIFIER_A)).toBeUndefined();
  });

  it("disables, never deletes, a member the seeded document no longer lists", async () => {
    await seed(VERIFIER_A);
    await seed(VERIFIER_B);
    const others = (await trustedVerifiers.listTrustedVerifiers())
      .map((row) => row.verifierId)
      .filter((verifierId) => verifierId !== VERIFIER_B);

    expect(await trustedVerifiers.disableVerifiersNotIn(others)).toEqual([VERIFIER_B]);
    const rows = await trustedVerifiers.listTrustedVerifiers();
    expect(rows.find((row) => row.verifierId === VERIFIER_A)?.status).toBe("active");
    expect(rows.find((row) => row.verifierId === VERIFIER_B)?.status).toBe("disabled");
    expect(await trustedVerifiers.disableVerifiersNotIn(others)).toEqual([]);
  });

  it("serves the same identities on the bulk-load stream as on the single-hash route", async () => {
    const [hash] = HASHES;
    await seed(VERIFIER_A, { displayName: "Verifier A" });
    await record(VERIFIER_A, hash, { url: `https://${VERIFIER_A}.spec.test/`, name: "Peer A" });
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;

    const page = await request(app.getHttpServer()).get("/api/query/v1/wasms?order=desc&limit=200");
    expect(page.status).toBe(200);
    const served = (
      page.body.records as { wasm_hash: string; source_code_verifications: { verifier: { url: string } }[] }[]
    ).find((candidate) => candidate.wasm_hash === hash);
    expect(served).toBeDefined();
    expect(served!.source_code_verifications.map((verification) => verification.verifier.url)).toContain(
      `https://${VERIFIER_A}.spec.test/`,
    );
  });

  it("agrees on both routes for a row retained before the peer's own block was stored", async () => {
    const hash = HASHES[1];
    await seed(VERIFIER_B, { displayName: "Not An Identity" });
    await record(VERIFIER_B, hash);
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;

    const single = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(single.status).toBe(200);
    const page = await request(app.getHttpServer()).get("/api/query/v1/wasms?order=desc&limit=200");
    expect(page.status).toBe(200);
    const streamed = (page.body.records as { wasm_hash: string; source_code_verifications: unknown[] }[]).find(
      (candidate) => candidate.wasm_hash === hash,
    );
    expect(streamed).toBeDefined();

    const identities = (entries: unknown[]) =>
      (entries as { verifier: { url: string } }[]).map((verification) => verification.verifier.url);
    expect(identities(streamed!.source_code_verifications)).toEqual(
      identities(single.body.source_code_verifications),
    );
    expect(identities(streamed!.source_code_verifications)).toContain(`https://${VERIFIER_B}.spec.test/`);
  });
});

describe("the retained copy is what /api/query/v1 serves, so the sync must not narrow it", () => {
  const PEER_ROOT = "https://peer.spec.test/";
  const BULK_LOAD_URL = `${PEER_ROOT}v1/results/wasms.json`;
  const REAL_FETCH = globalThis.fetch;

  const peerDocument = (wasmHash: string, overrides: Record<string, unknown> = {}) => ({
    schema_version: "1.0",
    wasm_hash: wasmHash,
    updated_at: "2026-07-01T00:00:00.000Z",
    source_code_verifications: [
      {
        verifier: { url: PEER_ROOT, name: "The Peer's Own Name For Itself" },
        status: "verified",
        bldimg: `docker.io/x/y@sha256:${"c".repeat(64)}`,
        source_repo: "https://github.com/example/contract",
        source_rev: "0".repeat(40),
        tarball_url: "https://example.test/source.tar.gz",
        tarball_sha256: "e".repeat(64),
        processed_at: "2026-07-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  });

  const bulkLoadPage = (wasmHash: string) => ({
    schema_version: "1.0",
    order: "asc",
    cursor: null,
    records: [{ wasm_hash: wasmHash, updated_at: "2026-07-01T00:00:00.000Z" }],
  });

  const serve = (document: unknown, wasmHash: string): void => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(BULK_LOAD_URL)) {
        return new Response(JSON.stringify(bulkLoadPage(wasmHash)), { status: 200 });
      }
      if (!url.startsWith(PEER_ROOT)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(document), { status: 200 });
    }) as typeof fetch;
  };

  const syncPeerOnce = async (wasmHash: string): Promise<void> => {
    await trustedVerifiers.upsertTrustedVerifier({
      verifierId: VERIFIER_A,
      manifestUrl: `${PEER_ROOT}verifier-manifest.json`,
      resultsRoot: PEER_ROOT,
      bulkLoadUrl: BULK_LOAD_URL,
      status: "active",
    });
    const sync = app.get(AggregationSyncService);
    await sync.syncOne({
      id: VERIFIER_A,
      display_name: VERIFIER_A,
      url: PEER_ROOT,
      manifest_url: `${PEER_ROOT}verifier-manifest.json`,
      bulk_load_url: BULK_LOAD_URL,
      trust_tier: undefined,
      status: "active",
    });
  };

  afterEach(async () => {
    globalThis.fetch = REAL_FETCH;
    await prisma.trustedVerifier.deleteMany({ where: { verifierId: { in: [VERIFIER_A, VERIFIER_B] } } });
  });

  it("normalises a peer's bare-string results_urls rather than relaying them into the aggregate", async () => {
    const [hash] = HASHES;
    const reportSha = "d".repeat(64);
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          {
            ...peerDocument(hash).source_code_verifications[0],
            results_urls: [`${PEER_ROOT}reports/${reportSha}.json`, "https://gateway.irys.xyz/legacy-tx"],
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    const [served] = res.body.source_code_verifications;
    expect(served.results_urls).toEqual([
      { type: "report", url: `${PEER_ROOT}reports/${reportSha}.json`, sha256: reportSha },
      { type: "report", url: "https://gateway.irys.xyz/legacy-tx" },
    ]);
  });

  it("keeps every field the peer sent, not the six the recipe column used to whitelist", async () => {
    const [hash] = HASHES;
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          {
            ...peerDocument(hash).source_code_verifications[0],
            source_sha256: "f".repeat(64),
            some_future_field: "kept",
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    const [served] = res.body.source_code_verifications;
    expect(served.tarball_sha256).toBe("e".repeat(64));
    expect(served.source_sha256).toBe("f".repeat(64));
    expect(served.some_future_field).toBe("kept");
    expect(served.status).toBe("verified");
    expect(served.processed_at).toBe("2026-07-01T00:00:00.000Z");
    expect(served.verifier).toEqual({ url: PEER_ROOT, name: "The Peer's Own Name For Itself" });
  });

  it("keeps a peer's draft-shape verified_source_code_uri, now through `recipe`", async () => {
    const [, , , hash] = HASHES;
    const uri = "https://peer.spec.test/source/abc.tar.gz";
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          {
            ...peerDocument(hash).source_code_verifications[0],
            verified_source_code_uri: uri,
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    const [served] = res.body.source_code_verifications;
    expect(served.verified_source_code_uri).toBe(uri);

    const row = await prisma.verificationResult.findUnique({
      where: { verifierId_wasmHash: { verifierId: VERIFIER_A, wasmHash: hash } },
    });
    expect((row?.recipe as Record<string, unknown>).verified_source_code_uri).toBe(uri);
  });

  it("relays the plural verified_source_code_uris through its own column", async () => {
    const [, , , hash] = HASHES;
    const uris = ["https://peer.spec.test/source/abc.tar.gz", "ar://tx"];
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          { ...peerDocument(hash).source_code_verifications[0], verified_source_code_uris: uris },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.body.source_code_verifications[0].verified_source_code_uris).toEqual(uris);
    const row = await prisma.verificationResult.findUnique({
      where: { verifierId_wasmHash: { verifierId: VERIFIER_A, wasmHash: hash } },
    });
    expect(row?.verifiedSourceCodeUris).toEqual(uris);
  });

  it("relays a link vocabulary a later MINOR added, instead of dropping the peer over one word", async () => {
    const [, , , hash] = HASHES;
    const links = [{ type: "license", location: "ipfs", url: "ipfs://bafy" }];
    serve(
      peerDocument(hash, {
        schema_version: "1.1",
        source_code_verifications: [
          {
            ...peerDocument(hash).source_code_verifications[0],
            results_urls: links,
            recipe_source: "attested_by_publisher",
            image_trust_level: "reproducible_bootstrap",
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications).toHaveLength(1);
    const [served] = res.body.source_code_verifications;
    expect(served.results_urls).toEqual(links);
    expect(served.recipe_source).toBe("attested_by_publisher");
    expect(served.image_trust_level).toBe("reproducible_bootstrap");
    expect(served.schema_version).toBe("1.1");
  });

  it("keeps a peer whose results_urls are bare strings, normalising rather than dropping the document", async () => {
    const [, , , hash] = HASHES;
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          {
            ...peerDocument(hash).source_code_verifications[0],
            results_urls: ["https://peer.spec.test/reports/abc.json"],
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);
    (app.get(AggregationSyncService) as unknown as { firstPassComplete: boolean }).firstPassComplete = true;

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications).toHaveLength(1);
    expect(res.body.source_code_verifications[0].results_urls).toEqual([
      { type: "report", url: "https://peer.spec.test/reports/abc.json" },
    ]);
    expect(oursOnly(res.body.unavailable_verifiers)).toEqual([]);
  });

  it("relays a non-string draft field unchanged instead of dropping it (CV8)", async () => {
    const [, , , hash] = HASHES;
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          { ...peerDocument(hash).source_code_verifications[0], verified_source_code_uri: 42 },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications[0].verified_source_code_uri).toBe(42);
    expect(res.body.source_code_verifications[0].tarball_sha256).toBe("e".repeat(64));
  });

  it("relays the peer's own identity unchanged, and the version of the document it came from (CV11)", async () => {
    const [, , , hash] = HASHES;
    serve(
      peerDocument(hash, {
        schema_version: "1.3",
        source_code_verifications: [
          {
            ...peerDocument(hash).source_code_verifications[0],
            verifier: { name: "Peer's Own Name For Itself", url: PEER_ROOT },
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    const [served] = res.body.source_code_verifications;

    expect(served.verifier).toEqual({ url: PEER_ROOT, name: "Peer's Own Name For Itself" });
    expect(served).not.toHaveProperty("verifier_id");
    expect(served).not.toHaveProperty("published_verifier");
    expect(served.schema_version).toBe("1.3");
    expect(res.body.schema_version).toBe("1.0");
    expect(res.body.schema).toBe("stellar-verification-aggregate");
  });

  it("takes the peer's OWN entry from a document that carries several", async () => {
    const [, , , hash] = HASHES;
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          {
            verifier: { name: "Somebody Else", url: "https://other.spec.test/" },
            status: "mismatched",
            processed_at: "2026-07-01T00:00:00.000Z",
          },
          {
            ...peerDocument(hash).source_code_verifications[0],
            verifier: { name: "The Peer", url: PEER_ROOT },
          },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    const [served] = res.body.source_code_verifications;
    expect(served.status).toBe("verified");
    expect(served.verifier.url).toBe(PEER_ROOT);
  });

  it("serves an unrecognised status as unverified (CV10) rather than passing it through", async () => {
    const [, , , hash] = HASHES;
    serve(
      peerDocument(hash, {
        source_code_verifications: [
          { ...peerDocument(hash).source_code_verifications[0], status: "provisionally_verified" },
        ],
      }),
      hash,
    );
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications[0].status).toBe("unverified");
    expect(res.body.source_code_verifications[0].tarball_sha256).toBe("e".repeat(64));
  });

  it("retains a peer that has moved to a higher MINOR instead of dropping it (SO7)", async () => {
    const [, hash] = HASHES;
    serve(peerDocument(hash, { schema_version: "1.1" }), hash);
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.status).toBe(200);
    expect(res.body.source_code_verifications).toHaveLength(1);
    expect(res.body.source_code_verifications[0].tarball_sha256).toBe("e".repeat(64));
    expect(oursOnly(res.body.unavailable_verifiers)).toEqual([]);
    expect(res.body.schema_version).toBe("1.0");
  });

  it("keeps the retained rows when a peer's MAJOR is one we cannot read, and says so", async () => {
    const [, , hash] = HASHES;
    serve(peerDocument(hash), hash);
    await syncPeerOnce(hash);

    serve(peerDocument(hash, { schema_version: "2.0" }), hash);
    await syncPeerOnce(hash);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.body.source_code_verifications).toHaveLength(1);
    const unavailable = oursOnly(res.body.unavailable_verifiers);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].url).toBe(PEER_ROOT);
  });
});

describe("GET /api/query/v1/contracts/:network/:contract_id", () => {
  it("separates the caller's mistakes from the ledger's, by status code", async () => {
    const badNetwork = await request(app.getHttpServer()).get(
      "/api/query/v1/contracts/nowhere/CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
    );
    expect(badNetwork.status).toBe(400);
    expect(badNetwork.body.error).toBe("invalid_network");

    const badAddress = await request(app.getHttpServer()).get(
      "/api/query/v1/contracts/testnet/not-a-contract",
    );
    expect(badAddress.status).toBe(400);
    expect(badAddress.body.error).toBe("invalid_contract_id");
  });
});

describe("discover() synthesizes a cursor from a short page instead of leaving it stuck", () => {
  const PEER_ROOT = "https://peer.aggregation.test/";
  const BULK_LOAD_URL = `${PEER_ROOT}v1/results/wasms.json`;
  const REAL_FETCH = globalThis.fetch;

  const statusDocument = (wasmHash: string) => ({
    schema_version: "1.0",
    wasm_hash: wasmHash,
    updated_at: "2026-07-01T00:00:00.000Z",
    source_code_verifications: [
      {
        verifier: { name: "irrelevant" },
        status: "verified",
        bldimg: `docker.io/x/y@sha256:${"c".repeat(64)}`,
        processed_at: "2026-07-01T00:00:00.000Z",
      },
    ],
  });

  const shortPage = (wasmHash: string, updatedAt: string) => ({
    schema_version: "1.0",
    order: "asc",
    cursor: null,
    records: [{ wasm_hash: wasmHash, updated_at: updatedAt }],
  });

  const syncOnce = async (): Promise<void> => {
    const sync = app.get(AggregationSyncService);
    await sync.syncOne({
      id: VERIFIER_A,
      display_name: VERIFIER_A,
      url: PEER_ROOT,
      manifest_url: `${PEER_ROOT}verifier-manifest.json`,
      bulk_load_url: BULK_LOAD_URL,
      trust_tier: undefined,
      status: "active",
    });
  };

  beforeEach(async () => {
    await trustedVerifiers.upsertTrustedVerifier({
      verifierId: VERIFIER_A,
      manifestUrl: `${PEER_ROOT}verifier-manifest.json`,
      resultsRoot: PEER_ROOT,
      bulkLoadUrl: BULK_LOAD_URL,
      status: "active",
    });
  });

  afterEach(async () => {
    globalThis.fetch = REAL_FETCH;
    await prisma.trustedVerifier.deleteMany({ where: { verifierId: VERIFIER_A } });
  });

  it("advances the stored cursor past a short page instead of leaving it empty", async () => {
    const [hash] = HASHES;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(BULK_LOAD_URL)) {
        return new Response(JSON.stringify(shortPage(hash, "2026-07-01T00:00:00.000Z")), { status: 200 });
      }
      return new Response(JSON.stringify(statusDocument(hash)), { status: 200 });
    }) as typeof fetch;

    expect(await aggregation.getCursor(VERIFIER_A)).toBeUndefined();
    await syncOnce();

    const stored = await aggregation.getCursor(VERIFIER_A);
    expect(stored?.cursor).toBeDefined();
    expect(stored?.cursor).toBe(`${new Date("2026-07-01T00:00:00.000Z").getTime()}-${hash}`);
  });

  it("still discovers a hash that legitimately reappears with a later update time (BL5) after the cursor advances", async () => {
    const [hash] = HASHES;
    let requestedCursor: string | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.toString().startsWith(BULK_LOAD_URL)) {
        requestedCursor = url.searchParams.get("cursor");
        const updatedAt = requestedCursor === null ? "2026-07-01T00:00:00.000Z" : "2026-07-02T00:00:00.000Z";
        return new Response(JSON.stringify(shortPage(hash, updatedAt)), { status: 200 });
      }
      return new Response(JSON.stringify(statusDocument(hash)), { status: 200 });
    }) as typeof fetch;

    await syncOnce();
    const afterFirst = await aggregation.getCursor(VERIFIER_A);
    expect(afterFirst?.cursor).toBe(`${new Date("2026-07-01T00:00:00.000Z").getTime()}-${hash}`);

    await syncOnce();
    expect(requestedCursor).toBe(afterFirst?.cursor);

    const afterSecond = await aggregation.getCursor(VERIFIER_A);
    expect(afterSecond?.cursor).toBe(`${new Date("2026-07-02T00:00:00.000Z").getTime()}-${hash}`);

    const res = await request(app.getHttpServer()).get(`/api/query/v1/wasms/${hash}`);
    expect(res.body.source_code_verifications).toHaveLength(1);
  });

  it("leaves the cursor unchanged when a page is genuinely empty — nothing to synthesize from", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(BULK_LOAD_URL)) {
        return new Response(
          JSON.stringify({ schema_version: "1.0", order: "asc", cursor: null, records: [] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await syncOnce();
    const stored = await aggregation.getCursor(VERIFIER_A);
    expect(stored?.cursor).toBeUndefined();
  });
});

describe("toTrustedVerifier() rejects a row with no bulk_load_url", () => {
  const PEER_ROOT = "https://peer.no-bulk.test/";

  afterEach(async () => {
    await prisma.trustedVerifier.deleteMany({ where: { verifierId: VERIFIER_A } });
  });

  it("is skipped-and-logged by loadTrustedVerifiersList rather than thrown all the way up", async () => {
    await trustedVerifiers.upsertTrustedVerifier({
      verifierId: VERIFIER_A,
      manifestUrl: `${PEER_ROOT}verifier-manifest.json`,
      resultsRoot: PEER_ROOT,
      status: "active",
    });

    const { loadTrustedVerifiersList } = await import("../src/common/tvl.js");
    const list = await loadTrustedVerifiersList(trustedVerifiers);
    expect(list.verifiers.some((verifier) => verifier.id === VERIFIER_A)).toBe(false);
  });
});
