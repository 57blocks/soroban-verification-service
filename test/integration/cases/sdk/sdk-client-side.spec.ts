import { caseBlock } from "../../support/gate.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../support/env.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";
import { expectStatus, http, sleep } from "../../support/http.js";
import { aggregatedByHashUrl, verifiersUrl } from "../../support/routes.js";
import { normalizeResultRoot } from "../../support/result-tree.js";
import { runSdkConsumer } from "../../support/sdk-consumer.js";
import type { AggregatedWasmStatus, TrustedVerifiersList } from "../../support/types.js";

const AGGREGATION_SYNC_TIMEOUT_MS = 100_000;
const AGGREGATION_SYNC_JEST_TIMEOUT_MS =
  AGGREGATION_SYNC_TIMEOUT_MS + env.requestTimeoutMs + env.pollIntervalMs + 10_000;

/** Verifier arrays compare as sets; bldarg/bldopt inside an entry stay order-significant. */
const byResultRoot = (left?: string, right?: string) =>
  normalizeResultRoot(left ?? "").localeCompare(normalizeResultRoot(right ?? ""));

function normaliseAggregate(value: AggregatedWasmStatus): Omit<AggregatedWasmStatus, "updated_at"> {
  const { updated_at: _updatedAt, ...aggregate } = value;
  return {
    ...aggregate,
    source_code_verifications: aggregate.source_code_verifications
      .map(({ retrieved_at: _retrievedAt, ...entry }) => entry)
      .sort((left, right) => byResultRoot(left.verifier.url, right.verifier.url)),
    unavailable_verifiers: [...aggregate.unavailable_verifiers].sort((left, right) =>
      byResultRoot(left.url, right.url),
    ),
  };
}

async function readTvl(): Promise<TrustedVerifiersList> {
  const response = await http(verifiersUrl());
  expectStatus(response, 200);
  return response.json as TrustedVerifiersList;
}

function fixtureHash(): string {
  return fixtures.contracts["F-LEG-1"].wasm_hash!;
}

function activeVerifierRoots(tvl: TrustedVerifiersList): string[] {
  const roots = tvl.verifiers
    .filter((verifier) => verifier.status === "active")
    .map((verifier) => normalizeResultRoot(verifier.url));
  expect(roots.length).toBeGreaterThanOrEqual(2);
  return roots;
}

const entryRoots = (aggregate: AggregatedWasmStatus): string[] =>
  aggregate.source_code_verifications.map((entry) => normalizeResultRoot(entry.verifier?.url ?? ""));

caseBlock(
  {
    id: "E2E-SDK-01",
    title: "the SDK aggregates two verifier result roots without the hosted query API",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1", "P2"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("returns both verifier entries without requesting a hosted aggregate route", async () => {
      const tvl = await readTvl();
      const expectedRoots = activeVerifierRoots(tvl);

      const result = runSdkConsumer({ tvl, wasmHash: fixtureHash() });
      const aggregate = result.aggregate as AggregatedWasmStatus;
      expect(entryRoots(aggregate)).toEqual(expect.arrayContaining(expectedRoots));
      expect(result.requests.some((url) => url.startsWith(`${env.queryUrl}/api/query/v1/`))).toBe(false);

      const statusRequests = result.requests.filter((url) => new URL(url).pathname.includes("/wasms/"));
      expect(statusRequests).toHaveLength(tvl.verifiers.filter((verifier) => verifier.status === "active").length);
    });
  },
);

caseBlock(
  {
    id: "E2E-SDK-04/node",
    title: "the built SDK runs in Node against two independent verifier roots",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1", "P2"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("loads the public TVL and returns both verifier results", async () => {
      const tvl = await readTvl();
      const result = runSdkConsumer({ tvl, wasmHash: fixtureHash() });
      const aggregate = result.aggregate as AggregatedWasmStatus;
      expect(entryRoots(aggregate)).toEqual(expect.arrayContaining(activeVerifierRoots(tvl)));
    });
  },
);

caseBlock(
  {
    id: "E2E-SDK-02",
    title: "the SDK and hosted aggregation expose the same two-verifier result shape",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1", "P2"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("matches entries and availability after the hosted cache observes the live result roots", async () => {
      const hash = fixtureHash();
      const tvl = await readTvl();
      const deadline = Date.now() + AGGREGATION_SYNC_TIMEOUT_MS;
      let clientSide: AggregatedWasmStatus | undefined;
      let hostedAggregate: AggregatedWasmStatus | undefined;

      while (Date.now() < deadline) {
        clientSide = runSdkConsumer({ tvl, wasmHash: hash }).aggregate as AggregatedWasmStatus;
        const hosted = await http(aggregatedByHashUrl(hash));
        expectStatus(hosted, 200);
        hostedAggregate = hosted.json as AggregatedWasmStatus;

        if (JSON.stringify(normaliseAggregate(clientSide)) === JSON.stringify(normaliseAggregate(hostedAggregate))) {
          break;
        }
        await sleep(env.pollIntervalMs);
      }

      if (!clientSide || !hostedAggregate) {
        throw new Error("E2E-SDK-02 did not obtain both aggregate snapshots before comparing them.");
      }
      expect(normaliseAggregate(clientSide)).toEqual(normaliseAggregate(hostedAggregate));
    }, AGGREGATION_SYNC_JEST_TIMEOUT_MS);
  },
);

caseBlock(
  {
    id: "E2E-SDK-07",
    title: "the SDK discovers both verifier manifests and policies from the public TVL",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1", "P2"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("reads and validates one manifest and policy per verifier", async () => {
      const tvl = await readTvl();
      const objectResult = runSdkConsumer({ tvl, wasmHash: fixtureHash() });
      const tvlDir = mkdtempSync(join(tmpdir(), "scvs-sdk-e2e-tvl-"));
      const tvlFile = join(tvlDir, "trusted-verifiers.json");
      writeFileSync(tvlFile, JSON.stringify(tvl));
      const fileResult = runSdkConsumer({ tvlFile, wasmHash: fixtureHash() });
      const urlResult = runSdkConsumer({
        tvlUrl: verifiersUrl(),
        wasmHash: fixtureHash(),
      });
      rmSync(tvlDir, { recursive: true, force: true });
      const result = objectResult;
      const activeRoots = activeVerifierRoots(tvl);
      const relevant = result.discoveries.filter(({ resultRoot }) =>
        activeRoots.includes(normalizeResultRoot(resultRoot)),
      );

      expect((fileResult.aggregate as AggregatedWasmStatus).source_code_verifications).toEqual(
        (objectResult.aggregate as AggregatedWasmStatus).source_code_verifications,
      );
      expect((urlResult.aggregate as AggregatedWasmStatus).source_code_verifications).toEqual(
        (objectResult.aggregate as AggregatedWasmStatus).source_code_verifications,
      );
      expect(urlResult.requests).toContain(verifiersUrl());
      expect(relevant).toHaveLength(activeRoots.length);
      for (const discovery of relevant) {
        expect(discovery.outcome).toBe("available");
        if (discovery.verifierId !== undefined) {
          expect(discovery.manifestId).toBe(discovery.verifierId);
        }
        expect(discovery.policyId?.length ?? 0).toBeGreaterThan(0);
      }
      expect(result.requests.filter((url) => url.endsWith("verifier-manifest.json")).length).toBeGreaterThanOrEqual(2);
      expect(result.requests.filter((url) => url.endsWith("policy.json")).length).toBeGreaterThanOrEqual(2);
    });
  },
);
