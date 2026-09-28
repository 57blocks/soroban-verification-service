import { caseBlock } from "../../support/gate.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { env } from "../../support/env.js";
import { expectStatus, http, sleep } from "../../support/http.js";
import { preflight, submit, waitForTerminal } from "../../support/job.js";
import { aggregatedByHashUrl } from "../../support/routes.js";
import { ownEntryOf, ownVerifierIdentity } from "../../support/result-tree.js";
import type { AggregatedWasmStatus } from "../../support/types.js";

const NETWORKS = [
  { suffix: "testnet", fixtureId: "F-LEG-1" },
  { suffix: "mainnet", fixtureId: "F-LEG-1-MAINNET" },
] as const;

function aggregateSummary(body: AggregatedWasmStatus): string {
  const entries = body.source_code_verifications.map((entry) => ({
    verifier: entry.verifier?.url,
    status: entry.status,
  }));
  const unavailable = body.unavailable_verifiers.map((entry) => ({
    verifier: entry.url,
    reason: entry.reason,
  }));
  return JSON.stringify({ agreement: body.agreement, entries, unavailable_verifiers: unavailable });
}

for (const row of NETWORKS) {
  caseBlock(
    {
      id: `E2E-SUB-01/${row.suffix}`,
      title: "preflight classifies the pair as composable; the client completes the recipe locally",
      mode: "AUTO",
      needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
      prerequisites: ["P1"],
      unless: () => missingFixture(row.fixtureId),
    },
    () => {
      const target = fixtures.contracts[row.fixtureId];

      it("preflight echoes the chain pair and asks for a source, not an environment", async () => {
        const response = await preflight({
          network: target.network,
          contract_id: target.contract_id,
          wasm_hash: target.wasm_hash,
        });
        expectStatus(response, 200);

        const body = response.json;

        expect(body.build_environment?.kind).toBe("compose");

        expect(body.missing_fields ?? []).not.toContain("bldimg");

        const missing: string[] = body.missing_fields ?? [];
        expect(missing.length).toBeGreaterThan(0);
        expect(missing).toEqual(expect.arrayContaining(["source_sha256"]));
        expect(missing.some((field) => field === "source_uri" || field === "upload_id")).toBe(true);
      });

      it(
        "accepts one fresh recipe, reaches verified, and appears on the public query surface",
        async () => {
          const submitted = await submit(await submissionFor(row.fixtureId));
          expectStatus(submitted.response, 202);
          expect(submitted.jobId).toBeDefined();
          expect(submitted.response.json.status).toBe("queued");

          expect(submitted.response.durationMs).toBeLessThan(5_000);

          const terminal = await waitForTerminal(submitted.jobId!);

          if (terminal.body.status !== "verified") {
            throw new Error(
              `Verification job ${submitted.jobId} did not reach verified. ` +
                `Final job status: ${terminal.body.status}. ` +
                `Result: ${JSON.stringify(terminal.body.result)}. ` +
                `Error: ${terminal.body.error ?? "(none)"}.`
            );
          }

          const wasmHash = terminal.body.result?.wasm_hash ?? target.wasm_hash;
          expect(wasmHash).toBeDefined();

          const identity = await ownVerifierIdentity();
          const queryUrl = aggregatedByHashUrl(wasmHash!);
          const deadline = Date.now() + 60_000;
          let ours: AggregatedWasmStatus["source_code_verifications"][number] | undefined;
          let lastAggregate: AggregatedWasmStatus | undefined;
          while (Date.now() < deadline) {
            const aggregate = await http(queryUrl);
            if (aggregate.status !== 200) {
              throw new Error(
                `Verification job ${submitted.jobId} reached verified for Wasm ${wasmHash}, but ` +
                  `query-svc did not return an aggregate. ${queryUrl} responded ${aggregate.status}. ` +
                  `Body: ${aggregate.text}`
              );
            }
            lastAggregate = aggregate.json as AggregatedWasmStatus;
            ours = ownEntryOf(lastAggregate.source_code_verifications, identity);
            if (ours) break;
            await sleep(env.pollIntervalMs);
          }
          if (!ours) {
            throw new Error(
              `Verification job ${submitted.jobId} reached verified for Wasm ${wasmHash}, but ` +
                `query-svc did not expose verifier.url=${identity.url} within 60000 ms. ` +
                `Query URL: ${queryUrl}. Last aggregate: ` +
                `${lastAggregate ? aggregateSummary(lastAggregate) : "(no successful aggregate response)"}.`
            );
          }
          if (ours.status !== "verified") {
            throw new Error(
              `Verification job ${submitted.jobId} reached verified for Wasm ${wasmHash}, but ` +
                `query-svc exposed verifier.url=${identity.url} with status ${JSON.stringify(ours.status)}. ` +
                `Query URL: ${queryUrl}. Last aggregate: ${aggregateSummary(lastAggregate!)}.`
            );
          }
        },
        env.jobTimeoutMs + 60_000
      );
    }
  );
}
