/** E2E-PUB-04 (SO1–SO5), E2E-PUB-07 (report provenance), E2E-PUB-08 (`results_urls`), E2E-PUB-17 (custody). */
import { caseBlock, rowTest } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { expectPerTrd } from "../../support/conformance.js";
import {
  fixtures,
  missingDeployedTarget,
  missingFixture,
  privateUploadChainRecipeSubmissionFor,
  submissionFor,
} from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import {
  ownEntryOf,
  ownVerifierIdentity,
  readReportByUrl,
  requireStatusObject,
  type OwnVerifierIdentity,
} from "../../support/result-tree.js";
import { linkUrls, type RegistryStatusObject, type RegistryVerification } from "../../support/types.js";
import { IMAGE_TRUST_LEVELS } from "../../support/status-schema.js";

const SEP58_BLDOPT_ENTRY = /^--[A-Za-z][A-Za-z0-9_-]*(=.*)?$/;

caseBlock(
  {
    id: "E2E-PUB-04",
    title: "status-object constraints SO1–SO5",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1", "F-LEG-3"),
  },
  () => {
    let verifiedStatus: RegistryStatusObject;
    let mismatchedStatus: RegistryStatusObject;
    let identity: OwnVerifierIdentity;

    beforeAll(async () => {
      identity = await ownVerifierIdentity();
      const verified = await submitAndWait(await submissionFor("F-LEG-1"));
      const mismatched = await submitAndWait(await submissionFor("F-LEG-3"));

      verifiedStatus = await requireStatusObject(
        verified.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash!
      );
      mismatchedStatus = await requireStatusObject(
        mismatched.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-3"].wasm_hash!
      );
    }, 2 * env.jobTimeoutMs + 180_000);

    it("/status_vocabulary — SO1: exactly three values, and `mismatched` is spelled in full", () => {
      for (const status of [verifiedStatus, mismatchedStatus]) {
        for (const entry of status.source_code_verifications) {
          expect(["verified", "mismatched", "unverified"]).toContain(entry.status);
          // Stated as its own assertion because `mismatch` is the one spelling that would pass a loose enum
          // check on the *job* surface and fail a consumer parsing the Registry schema.
          expect(entry.status).not.toBe("mismatch");
        }
      }
    });

    it("/rebuilt_hash_only_when_mismatched — SO2: present iff mismatched, and omitted, not null", () => {
      const collect = (status: RegistryStatusObject) => status.source_code_verifications;
      for (const entry of [...collect(verifiedStatus), ...collect(mismatchedStatus)]) {
        if (entry.status === "mismatched") {
          expect(typeof entry.rebuilt_hash).toBe("string");
        } else {
          // `null` would be a third state a consumer has to handle; the schema says omit.
          expect(Object.prototype.hasOwnProperty.call(entry, "rebuilt_hash")).toBe(false);
        }
      }
    });

    it("/processed_at_omitted_for_unverified — SO3", () => {
      for (const entry of [
        ...verifiedStatus.source_code_verifications,
        ...mismatchedStatus.source_code_verifications,
      ]) {
        if (entry.status === "unverified") {
          expect(Object.prototype.hasOwnProperty.call(entry, "processed_at")).toBe(false);
        } else {
          expect(typeof entry.processed_at).toBe("string");
        }
      }
    });

    it("/at_least_one_entry — SO4: a published object is never an empty array", () => {
      // The corollary matters as much as the rule: "no verifications" is expressed as a 404 on the document,
      // not as a 200 carrying nothing.
      expect(verifiedStatus.source_code_verifications.length).toBeGreaterThanOrEqual(1);
      expect(mismatchedStatus.source_code_verifications.length).toBeGreaterThanOrEqual(1);
    });

    it("/bldopt_equals_form — SO5: one complete flag per entry, values in `=` form", () => {
      for (const entry of [
        ...verifiedStatus.source_code_verifications,
        ...mismatchedStatus.source_code_verifications,
      ]) {
        for (const option of entry.bldopt ?? []) {
          expect(option).toMatch(SEP58_BLDOPT_ENTRY);
        }
      }
    });

    it("/bldarg_matches_the_report — the recipe on the entry is the recipe the report records", async () => {
      // `bldarg` reached the status object, and it is the half of the recipe a consumer
      // replaying from the entry alone did not have. SEP-58 v0.6.0 makes it order-significant, so
      // this is `toEqual` on the array and never a set comparison. The entry and the report it
      // points at are written by one pipeline from one recipe; a disagreement means one is stale.
      const ours = ownEntryOf(verifiedStatus.source_code_verifications, identity);
      expect(ours).toBeDefined();
      // Non-vacuity: F-LEG-1 carries `["contract", "build"]`, so an empty array on both sides would
      // be the failure this asserts against rather than a pass.
      expect(ours!.bldarg).toEqual(fixtures.contracts["F-LEG-1"].bldarg);

      const pointer = linkUrls(ours!).find((url) => url.includes("/reports/"));
      expect(pointer).toBeDefined();
      const { artifact } = await readReportByUrl(pointer!);
      const options = (artifact.build_recipe as { build_options?: { bldarg?: string[] } } | undefined)
        ?.build_options;
      expect(ours!.bldarg ?? []).toEqual(options?.bldarg ?? []);
    });

    it("carries the schema version and the hash it is keyed by", () => {
      expect(typeof verifiedStatus.schema_version).toBe("string");
      expect(verifiedStatus.wasm_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isNaN(Date.parse(verifiedStatus.updated_at))).toBe(false);
    });

    it("identifies this verifier in a way a consumer can follow back to a policy", () => {
      // Retargeted 2026-09-04: this asserted `verifier.name` was a string. A name is
      // self-claimed, optional, and leads nowhere. `verifier.url` is the result root — the place
      // `verifier-manifest.json` and `policy.json` actually are — which is what makes this title's
      // sentence true. That those two are reachable is E2E-PUB-02's assertion, not a second copy here.
      const ours = ownEntryOf(verifiedStatus.source_code_verifications, identity);
      expect(ours).toBeDefined();
      expect(ours!.verifier.url).toBe(identity.url);
    });
  }
);

caseBlock(
  {
    id: "E2E-PUB-07",
    title: "report provenance and trust fields (RA3–RA5)",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "records where the recipe came from, how it was isolated, and the full recipe",
      async () => {
        const run = await submitAndWait(await submissionFor("F-LEG-1", { is_public: true }));
        const url = run.body.result?.artifact_url;
        expect(url).toBeDefined();

        const { artifact } = await readReportByUrl(url!);

        // /recipe_source — F-LEG-1's recipe was supplied by the submitter, so `submitted`.
        expect(artifact.provenance.recipe_source).toBe("submitted");

        // /build_isolation — this is a live F-LEG-1 submission, so assert the mechanism it actually runs rather
        // than accepting the historical CLI-managed value.
        expect(artifact.provenance.build_isolation).toBe("network_isolated");

        // /full_recipe_with_bldarg — the recipe is evidence, so it has to be complete enough to replay.
        const recipe = artifact.build_recipe as Record<string, unknown> | undefined;
        expect(recipe).toBeDefined();

        // This read `recipe!.source_sha256`, transcribed from IMPLEMENTATION-SPEC D.1's example, whose `recipe`
        // block carries `source_sha256` and `source_uri`.
        expect(artifact.source!.source_sha256).toBe(fixtures.contracts["F-LEG-1"].source_sha256);

        expect(artifact.source!.is_public).toBe(true);
        expect(typeof artifact.source!.source_file_name).toBe("string");
        expect(typeof artifact.source!.source_uri).toBe("string");

        // /trust_block — one field, and only one.
        expect(typeof artifact.trust.sep55_attestation_present).toBe("boolean");

        // /build_environment_trust_level — canonical home is the build_recipe block, not `trust`.
        const buildEnvironment = recipe?.build_environment as { trust_level?: string } | undefined;
        if (buildEnvironment?.trust_level) {
          expect(["sdf_trusted", "upstream_pinned"]).toContain(buildEnvironment.trust_level);
        }

        // /log_pointer — no `build_log_url` field exists anywhere in the codebase.
        expectPerTrd("REPORT_LOG_POINTER", "E2E-PUB-07/log_pointer", () => {
          const diagnostics = (artifact.result.sandbox_diagnostics ?? {}) as Record<string, unknown>;
          expect(typeof diagnostics.build_log_url).toBe("string");
        });
      },
      env.jobTimeoutMs + 60_000
    );

    rowTest(
      "/recipe_source for a caller manifest matching a cli-58 chain recipe is `on_chain_metadata`",
      missingDeployedTarget("F-58-PRIV"),
      async () => {
        const prepared = await privateUploadChainRecipeSubmissionFor("F-58-PRIV");
        expect(prepared.body.manifest?.upload_id).toBeDefined();
        expect(prepared.body.manifest?.source_uri).toBeUndefined();
        expect(prepared.body.manifest?.bldarg).toEqual(prepared.chainRecipe.bldarg);
        expect(prepared.body.manifest?.bldopt).toEqual(prepared.chainRecipe.bldopt);

        const run = await submitAndWait(prepared.body);
        expect(run.body.status).toBe("verified");
        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.provenance.recipe_source).toBe("on_chain_metadata");
        expect(artifact.provenance.build_isolation).toBe("network_isolated");
      },
      env.jobTimeoutMs + 60_000
    );
  }
);

caseBlock(
  {
    id: "E2E-PUB-08",
    title: "report `results_urls` entries hash to their content-addressed path",
    mode: "AUTO",
    needs: ["SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "fetches each entry and compares",
      async () => {
        const run = await submitAndWait(await submissionFor("F-LEG-1"));
        const status = await requireStatusObject(
          run.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash!
        );

        const entries = status.source_code_verifications.flatMap(
          (verification: RegistryVerification) => verification.results_urls ?? []
        );

        // Results SEP 1.0 (AU1): every entry this verifier publishes is `{type, url, sha256}`, and the sha256
        // is the integrity anchor for the bytes at `url` — the report and its archive copy alike.
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
          expect(typeof entry).toBe("object");
          if (typeof entry === "string") continue;
          expect(entry.type).toBe("report");
          expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
          if (!/^https?:\/\//.test(entry.url)) continue;

          const fetched = await http(entry.url);
          if (fetched.status !== 200 && !entry.url.includes("/reports/")) continue; // an archive gateway may lag
          expectStatus(fetched, 200);
          expect(sha256Hex(fetched.bytes)).toBe(entry.sha256);
        }
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

caseBlock(
  {
    id: "E2E-PUB-17",
    title: "`recipe_source` records chain of custody, and never contradicts the report",
    mode: "AUTO",
    needs: ["SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    // Retargeted 2026-09-04: `out_of_band` became `recipe_source` + `image_trust_level`.
    // The suffixes keep their old spelling — `setup/run-e2e-test.mjs` gates a fixture on `/on_chain_false`.
    const rows = [
      { suffix: "submitted_true", fixtureId: "F-LEG-1", recipeSource: "submitted" },
      { suffix: "on_chain_false", fixtureId: "F-58-PRIV", recipeSource: "on_chain_metadata" },
    ] as const;

    for (const row of rows) {
      rowTest(
        `/${row.suffix}`,
        row.fixtureId === "F-58-PRIV"
          ? missingDeployedTarget(row.fixtureId)
          : missingFixture(row.fixtureId),
        async () => {
          const body =
            row.fixtureId === "F-58-PRIV"
              ? (await privateUploadChainRecipeSubmissionFor(row.fixtureId)).body
              : await submissionFor(row.fixtureId);
          const run = await submitAndWait(body);
          const hash = run.body.result?.wasm_hash ?? fixtures.contracts[row.fixtureId].wasm_hash!;
          const status = await requireStatusObject(hash);
          const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());

          // HA1 — present on every entry carrying a verdict (SO3). `undefined` is not `on_chain_metadata`.
          expect(ours).toBeDefined();
          expect(ours!.status).not.toBe("unverified");
          expect(ours!.recipe_source).toBe(row.recipeSource);

          // HA1b — the second custody signal. Membership of the schema's own enum, because which
          // value a deployment produces depends on the image it built with.
          expect(IMAGE_TRUST_LEVELS).toContain(ours!.image_trust_level);

          // HA1c — the field they replaced is gone: the SEP entry object is closed.
          expect(ours!.out_of_band).toBeUndefined();

          // HA2 — and the report agrees. These two are written by the same pipeline from the same decision; a
          // disagreement means one of them is stale.
          const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
          expect(artifact.provenance.recipe_source).toBe(row.recipeSource);
        },
        env.jobTimeoutMs + 60_000
      );
    }
  }
);
