import { caseBlock, rowTest } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectErrorEnvelope, expectStatus, http } from "../../support/http.js";
import { submitAccepted, submitAndWait, waitForTerminal } from "../../support/job.js";
import {
  aggregatedByHashUrl,
  ownBulkLoadUrl,
  staticWasmStatusUrl,
  verifyWasmStatusUrl,
} from "../../support/routes.js";
import { readStatusObject, readVerifierManifest, requireStatusObject } from "../../support/result-tree.js";
import {
  readStatusFormsUntilAgreed,
  STATUS_AGREEMENT_TIMEOUT_MS,
} from "../../support/status-agreement.js";
import type { BulkLoadPage } from "../../support/types.js";

const NEVER_SUBMITTED_HASH = "f".repeat(64);
const PAGINATION_LIMIT = 1;
const MAX_PAGINATION_PAGES = 200;

type BulkRecord = { wasm_hash: string; updated_at: string };

function assertUpsertableStream(records: readonly BulkRecord[]): void {
  const keys = new Set<string>();
  const latestByHash = new Map<string, number>();
  let previousKey: { timestamp: number; wasm_hash: string } | undefined;

  for (const record of records) {
    const timestamp = Date.parse(record.updated_at);
    expect(Number.isNaN(timestamp)).toBe(false);

    const key = `${timestamp}-${record.wasm_hash}`;
    expect(keys.has(key)).toBe(false);
    keys.add(key);

    if (previousKey) {
      const isAfterPrevious =
        timestamp > previousKey.timestamp ||
        (timestamp === previousKey.timestamp && record.wasm_hash > previousKey.wasm_hash);
      expect(isAfterPrevious).toBe(true);
    }
    previousKey = { timestamp, wasm_hash: record.wasm_hash };

    const previousTimestamp = latestByHash.get(record.wasm_hash);
    if (previousTimestamp !== undefined) {
      expect(timestamp).toBeGreaterThan(previousTimestamp);
    }
    latestByHash.set(record.wasm_hash, timestamp);
  }
}

caseBlock(
  {
    id: "E2E-PUB-02",
    title: "the result root holds only hash-addressed documents",
    mode: "AUTO",
    needs: ["SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
  },
  () => {
    const forbidden = [
      { key: "feeds/latest.json", why: "ADR-010 removed the feeds lookup files" },
      { key: "feeds/testnet/2026-06-30.jsonl", why: "date-partitioned enumeration" },
      { key: "index.json", why: "file-based enumeration; §5.4 makes enumeration a route" },
      { key: "page-1.json", why: "sequence-numbered pagination in the tree" },
      { key: "by-hash/testnet/index.json", why: "the pre-ADR-010 by-hash lookup tree" },
      { key: "wasms/testnet/index.json", why: "network partitioning under wasms/ (PUB-10 HA1)" },
    ];

    for (const probe of forbidden) {
      it(`has no ${probe.key} — ${probe.why}`, async () => {
        const result = await http(`${env.resultRoot}/${probe.key}`);
        expect([403, 404]).toContain(result.status);
      });
    }

    rowTest(
      "HA2 — no object is keyed by a Stellar address",
      missingFixture("F-LEG-1"),
      async () => {
        const contractId = fixtures.contracts["F-LEG-1"].contract_id!;
        for (const key of [`${contractId}.json`, `contracts/${contractId}.json`, `wasms/${contractId}.json`]) {
          const result = await http(`${env.resultRoot}/${key}`);
          expect([403, 404]).toContain(result.status);
        }
      }
    );
  }
);

caseBlock(
  {
    id: "E2E-PUB-09",
    title: "a failed job publishes nothing — not even a negative record",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () =>
      fixtures.unreachable_source_uri
        ? missingFixture("F-LEG-1")
        : "fixtures.unreachable_source_uri is not in the inventory",
  },
  () => {
    it(
      "does not alter either public surface after a failure",
      async () => {
        const target = fixtures.contracts["F-LEG-1"];

        const staticBefore = await readStatusObject(target.wasm_hash!);
        const dynamicBefore = await http(aggregatedByHashUrl(target.wasm_hash!));
        expectStatus(dynamicBefore, 200, 202, 404);

        const run = await submitAndWait(
          await submissionFor("F-LEG-1", { source_uri: fixtures.unreachable_source_uri! })
        );

        expect(["source_unavailable", "build_failed"]).toContain(run.body.status);

        const before = staticBefore;

        const dynamic = await http(aggregatedByHashUrl(target.wasm_hash!));
        expectStatus(dynamic, 200, 202, 404);
        expect(dynamic.status).toBe(dynamicBefore.status);
        if (dynamic.status === 200 && dynamicBefore.status === 200) {
          // updated_at is assigned per response, so it is left out of the comparison.
          const { updated_at: _beforeUpdatedAt, ...beforeAggregate } = dynamicBefore.json;
          const { updated_at: _afterUpdatedAt, ...afterAggregate } = dynamic.json;
          expect(afterAggregate).toEqual(beforeAggregate);
        }

        const after = await readStatusObject(target.wasm_hash!);
        expect(after.found).toBe(before.found);
        if (before.found && after.found) expect(after.object).toEqual(before.object);

        expect(run.body.result?.reason ?? run.body.error).toBeDefined();
      },
      env.jobTimeoutMs + 60_000
    );
  }
);

caseBlock(
  {
    id: "E2E-PUB-11",
    title: "bulk-load pagination loses nothing and exposes re-delivery as an upsert stream",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1", "F-LEG-3"),
  },
  () => {
    let publishedHashes: string[] = [];
    let baselineCursor: string | undefined;

    function cursorFor(record: BulkRecord): string {
      return `${Date.parse(record.updated_at)}-${record.wasm_hash}`;
    }

    beforeAll(
      async () => {
        const verifiedFixture = fixtures.contracts["F-LEG-1"];
        const mismatchedFixture = fixtures.contracts["F-LEG-3"];

        expect(verifiedFixture.wasm_hash).toBeDefined();
        expect(mismatchedFixture.wasm_hash).toBeDefined();
        expect(verifiedFixture.wasm_hash).not.toBe(mismatchedFixture.wasm_hash);

        const latest = await http(ownBulkLoadUrl({ order: "desc", limit: 1 }));
        expectStatus(latest, 200);
        const latestPage = latest.json as BulkLoadPage;
        expect(latestPage.records.length).toBeLessThanOrEqual(1);
        if (latestPage.records.length === 1) {
          baselineCursor = cursorFor(latestPage.records[0]);
        }

        const verified = await submitAndWait(await submissionFor("F-LEG-1"));
        const mismatched = await submitAndWait(await submissionFor("F-LEG-3"));
        expect(verified.body.status).toBe("verified");
        expect(mismatched.body.status).toBe("mismatch");

        publishedHashes = [
          verified.body.result?.wasm_hash ?? verifiedFixture.wasm_hash!,
          mismatched.body.result?.wasm_hash ?? mismatchedFixture.wasm_hash!,
        ];
        expect([...new Set(publishedHashes)]).toHaveLength(2);
      },
      2 * env.jobTimeoutMs + 120_000
    );

    async function drainLimitOne() {
      const seen: BulkRecord[] = [];
      const cursors = new Set<string>();
      let cursor = baselineCursor;
      const targetHashes = new Set(publishedHashes);
      const observedTargets = new Set<string>();

      for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
        const response = await http(ownBulkLoadUrl({ limit: PAGINATION_LIMIT, order: "asc", cursor }));
        expectStatus(response, 200);
        const body = response.json as BulkLoadPage;
        expect(body.records.length).toBeLessThanOrEqual(PAGINATION_LIMIT);

        if (body.records.length === 0) {
          expect(body.cursor).toBeNull();
          break;
        }

        expect(body.records).toHaveLength(PAGINATION_LIMIT);
        if (body.cursor === null) throw new Error("A non-empty limit=1 bulk-load page has no cursor.");
        expect(body.cursor).toMatch(/^\d+-[0-9a-f]{64}$/);
        expect(cursors.has(body.cursor)).toBe(false);
        cursors.add(body.cursor);
        seen.push(...body.records);
        for (const record of body.records) {
          if (targetHashes.has(record.wasm_hash)) observedTargets.add(record.wasm_hash);
        }
        cursor = body.cursor;

        if (observedTargets.size === targetHashes.size) return seen;
      }

      throw new Error(
        `E2E-PUB-11 did not observe both newly published hashes within ${MAX_PAGINATION_PAGES} ` +
          `limit=1 pages (baseline=${baselineCursor ?? "empty"}, observed=${[...observedTargets].join(",")}).`
      );
    }

    it("/cursor_format — limit=1 yields a cursor that retrieves a different next page", async () => {
      const first = await http(ownBulkLoadUrl({ limit: PAGINATION_LIMIT, order: "asc" }));
      expectStatus(first, 200);
      const firstPage = first.json as BulkLoadPage;
      expect(firstPage.records).toHaveLength(PAGINATION_LIMIT);
      expect(firstPage.cursor).toMatch(/^\d+-[0-9a-f]{64}$/);

      const second = await http(
        ownBulkLoadUrl({ limit: PAGINATION_LIMIT, order: "asc", cursor: firstPage.cursor! })
      );
      expectStatus(second, 200);
      const secondPage = second.json as BulkLoadPage;
      expect(secondPage.records).toHaveLength(PAGINATION_LIMIT);
      const firstRecord = firstPage.records[0];
      const secondRecord = secondPage.records[0];
      const firstTimestamp = Date.parse(firstRecord.updated_at);
      const secondTimestamp = Date.parse(secondRecord.updated_at);
      expect(
        secondTimestamp > firstTimestamp ||
          (secondTimestamp === firstTimestamp && secondRecord.wasm_hash > firstRecord.wasm_hash),
      ).toBe(true);
    });

    it("/no_duplicate_cursor_keys — re-delivery is ordered and two newly published hashes appear", async () => {
      const seen = await drainLimitOne();
      assertUpsertableStream(seen);
      const hashes = seen.map((record) => record.wasm_hash);
      for (const hash of publishedHashes) {
        expect(hashes.filter((seenHash) => seenHash === hash).length).toBeGreaterThanOrEqual(1);
      }
    });

    it("/sorted_by_publication_update — ascending order is monotone in `updated_at`", async () => {
      const seen = await drainLimitOne();
      assertUpsertableStream(seen);
      expect(seen.length).toBeGreaterThanOrEqual(2);

      for (let index = 1; index < seen.length; index += 1) {
        expect(Date.parse(seen[index].updated_at)).toBeGreaterThanOrEqual(
          Date.parse(seen[index - 1].updated_at)
        );
      }
    });

    it("rejects a malformed cursor rather than silently restarting the stream", async () => {
      const response = await http(ownBulkLoadUrl({ cursor: "not-a-cursor" }));
      expectStatus(response, 400);
      expect(response.json.error).toBe("invalid_cursor");
    });
  }
);

caseBlock(
  {
    id: "E2E-PUB-14",
    title: "the manifest identifies this verifier and resolves to its policy",
    mode: "AUTO",
    needs: ["SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
  },
  () => {
    it("is retrievable, and its `policy_url` reaches a policy document", async () => {
      const manifest = await readVerifierManifest();

      expect(manifest.schema).toBe("stellar-verifier-manifest-v1");
      expect(manifest.id.length).toBeGreaterThan(0);
      expect(manifest.display_name.length).toBeGreaterThan(0);
      expect(manifest.url.length).toBeGreaterThan(0);

      const policy = await http(new URL(manifest.policy_url, `${manifest.url}/`).toString());
      expectStatus(policy, 200);
      expect(policy.json.schema).toBe("stellar-verifier-policy-v1");
    });
  }
);

caseBlock(
  {
    id: "E2E-PUB-15",
    title: "the verifier's dynamic Wasm status distinguishes published, active, and absent hashes",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    // Drain the in-flight job, or it later rewrites the status document other specs read.
    let inFlightJobId: string | undefined;

    afterAll(async () => {
      if (inFlightJobId) await waitForTerminal(inFlightJobId);
    }, env.jobTimeoutMs + 60_000);

    it(
      "serves the published tree verbatim and distinguishes it from a never-seen hash",
      async () => {
        const done = await submitAndWait(await submissionFor("F-LEG-1"));
        const doneHash = done.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash!;
        await requireStatusObject(doneHash);

        const neverStatic = await http(staticWasmStatusUrl(NEVER_SUBMITTED_HASH));
        expect([403, 404]).toContain(neverStatic.status);
        expect(neverStatic.json?.schema).not.toBe("stellar-verification-error");

        const { staticRead, dynamicRead, uppercaseRead } = await readStatusFormsUntilAgreed(doneHash);
        expectStatus(staticRead, 200);
        expectStatus(dynamicRead, 200);
        expectStatus(uppercaseRead, 200);
        expect(dynamicRead.text).toBe(staticRead.text);
        expect(uppercaseRead.text).toBe(staticRead.text);

        const neverDynamic = await http(verifyWasmStatusUrl(NEVER_SUBMITTED_HASH));
        expectStatus(neverDynamic, 404);
        expect(expectErrorEnvelope(neverDynamic).error).toBe("not_found");
      },
      env.jobTimeoutMs + STATUS_AGREEMENT_TIMEOUT_MS + 60_000
    );

    it(
      "returns the draft pending 202 while a verification is in flight",
      async () => {
        const target = fixtures.contracts["F-LEG-1"];
        const wasmHash = target.wasm_hash;
        if (!wasmHash) throw new Error("F-LEG-1 was selected without a wasm_hash");
        inFlightJobId = (await submitAccepted(await submissionFor("F-LEG-1"))).jobId;

        const deadline = Date.now() + 30_000;
        let pending;
        while (Date.now() < deadline) {
          pending = await http(verifyWasmStatusUrl(wasmHash));
          if (pending.status === 202) break;
          await new Promise((resolve) => setTimeout(resolve, env.pollIntervalMs));
        }
        expectStatus(pending!, 202);
        const staticWhileActive = await http(staticWasmStatusUrl(wasmHash));
        expectStatus(staticWhileActive, 200, 404);
        expect(pending!.json).toEqual(
          expect.objectContaining({
            schema_version: "1.0",
            wasm_hash: target.wasm_hash,
            source_code_verifications: [
              expect.objectContaining({ status: "unverified" }),
            ],
          }),
        );
        expect(pending!.json.source_code_verifications[0]).not.toHaveProperty("processed_at");
        expect(pending!.json.source_code_verifications[0]).not.toHaveProperty("source_sha256");
      },
      env.jobTimeoutMs
    );
  }
);
