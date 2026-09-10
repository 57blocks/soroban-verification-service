/** E2E-SUB-13 — `bldopt` round-trips exactly, and is never silently dropped */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { expectPerTrd } from "../../support/conformance.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectErrorEnvelope, expectStatus } from "../../support/http.js";
import { submit, submitAndWait } from "../../support/job.js";
import { reportForJob } from "../../support/result-tree.js";

caseBlock(
  {
    id: "E2E-SUB-13/equals_form_with_escaping",
    title: "an `=` entry containing spaces and quotes round-trips byte-for-byte",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    // The case's own value. Quotes inside a value are where naive shell assembly splits an entry into three and
    // the build fails for a reason that has nothing to do with the source.
    const ENTRY = "--env=B='this is very nice'";

    it(
      "accepts it, replays it, and publishes it unchanged",
      async () => {
        const baseBldopt = fixtures.contracts["F-LEG-1"].bldopt ?? [];
        const body = await submissionFor("F-LEG-1", { bldopt: [...baseBldopt, ENTRY] });
        const run = await submitAndWait(body);

        // HA1 — accepted, not treated as malformed. Anything in the four failure states would mean the entry
        // was rejected or broke the build.
        expect(["verified", "mismatch"]).toContain(run.body.status);

        // HA2 — byte-for-byte. `toBe` on the string, not a normalised comparison: normalisation is precisely
        // what must not have happened.
        const report = await reportForJob(run.body.result, run.body.result?.wasm_hash);
        expect(report).toBeDefined();

        const recipe = report!.artifact.build_recipe as
          | { build_options?: { bldopt?: string[] } }
          | undefined;
        expect(recipe?.build_options?.bldopt).toBeDefined();
        expect(recipe!.build_options!.bldopt).toContain(ENTRY);

        // HA3 — the build did not fail from split quoting.
        expect(run.body.result?.reason).not.toBe("build_failed");
      },
      env.jobTimeoutMs + 60_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SUB-13/non_equals_form",
    title: "a two-entry flag is rejected or normalised — never dropped",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-MULTIPKG"),
  },
  () => {
    it("refuses the split form rather than quietly building the default package", async () => {
      const outcome = await submit(
        await submissionFor("F-MULTIPKG", {
          bldopt: ["--manifest-path", "contracts/contract-b/Cargo.toml"],
        })
      );

      // HA2 is the one that matters: the option must never be dropped.
      expect(outcome.response.status).toBeGreaterThanOrEqual(400);
      expect(outcome.jobId).toBeUndefined();

      const envelope = expectErrorEnvelope(outcome.response);

      // The message names the exact edit — `--manifest-path=contracts/contract-b/Cargo.toml` — so the submitter
      // is not left to infer the rule from a restatement of it.
      expect(envelope.detail ?? envelope.message).toMatch(/--manifest-path=/);

      // HA1 offers two acceptable answers, `policy_rejected` or normalisation.
      expectPerTrd("BLDOPT_NON_EQUALS_ERROR", "E2E-SUB-13/non_equals_form", () => {
        expect(envelope.error).toBe("policy_rejected");
      });
    });

    it(
      "builds the named package when the same option is written in `=` form",
      async () => {
        // The positive control, and E2E-SEC-05/manifest_path_normalized's assertion: with the correctly-spelled
        // option the workspace's non-default package is what gets built, which shows up as a verdict against
        // contract-b's deployed hash.
        const run = await submitAndWait(await submissionFor("F-MULTIPKG"));
        expect(run.body.status).toBe("verified");

        const report = await reportForJob(run.body.result, run.body.result?.wasm_hash);
        const recipe = report?.artifact.build_recipe as
          | { build_options?: { bldopt?: string[] } }
          | undefined;
        expect(recipe?.build_options?.bldopt ?? []).toContain(
          fixtures.contracts["F-MULTIPKG"].bldopt![0]
        );
      },
      env.jobTimeoutMs + 60_000
    );
  }
);
