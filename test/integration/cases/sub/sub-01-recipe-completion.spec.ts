import { caseBlock } from "../../support/gate.js";
import { fixtures, missingFixture, recipeScopeOf, submissionFor } from "../../support/fixtures.js";
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
          const submission = await submissionFor(row.fixtureId);
          // The aggregate keeps one entry per verifier per Wasm, so an earlier run's entry for this
          // Wasm is already there before ours lands. Only the run-scoped recipe tells them apart.
          const recipeScope = recipeScopeOf(submission.manifest.bldopt);
          if (recipeScope === undefined) {
            throw new Error(
              `${row.fixtureId} must set run_scoped_recipe: E2E-SUB-01 tells this job's query entry ` +
                `from an earlier run's by the E2E_RECIPE_SCOPE option in bldopt.`
            );
          }
          const submitted = await submit(submission);
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
          type Entry = AggregatedWasmStatus["source_code_verifications"][number];
          let ours: Entry | undefined;
          let lastOwn: Entry | undefined;
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
            lastOwn = ownEntryOf(lastAggregate.source_code_verifications, identity);
            if (lastOwn && recipeScopeOf(lastOwn.bldopt) === recipeScope) {
              ours = lastOwn;
              break;
            }
            await sleep(env.pollIntervalMs);
          }
          if (!ours) {
            const earlier = lastOwn
              ? `It still shows an earlier entry from this verifier: status ${JSON.stringify(lastOwn.status)}, ` +
                `processed_at ${lastOwn.processed_at ?? "(absent)"}, ` +
                `${recipeScopeOf(lastOwn.bldopt) ?? "no recipe scope"}. `
              : "";
            throw new Error(
              `Verification job ${submitted.jobId} reached verified for Wasm ${wasmHash}, but ` +
                `query-svc did not expose this job's entry (verifier.url=${identity.url}, bldopt ` +
                `carrying ${recipeScope}) within 60000 ms. ${earlier}` +
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
