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
      const ours = ownEntryOf(verifiedStatus.source_code_verifications, identity);
      expect(ours).toBeDefined();
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

        expect(artifact.provenance.recipe_source).toBe("submitted");

        expect(artifact.provenance.build_isolation).toBe("network_isolated");

        const recipe = artifact.build_recipe as Record<string, unknown> | undefined;
        expect(recipe).toBeDefined();

        expect(artifact.source!.source_sha256).toBe(fixtures.contracts["F-LEG-1"].source_sha256);

        expect(artifact.source!.is_public).toBe(true);
        expect(typeof artifact.source!.source_file_name).toBe("string");
        expect(typeof artifact.source!.source_uri).toBe("string");

        expect(typeof artifact.trust.sep55_attestation_present).toBe("boolean");

        const buildEnvironment = recipe?.build_environment as { trust_level?: string } | undefined;
        if (buildEnvironment?.trust_level) {
          expect(["sdf_trusted", "upstream_pinned"]).toContain(buildEnvironment.trust_level);
        }

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
    // run-e2e-test.mjs selects fixtures by these suffixes (`on_chain_false`); do not rename them.
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

          expect(ours).toBeDefined();
          expect(ours!.status).not.toBe("unverified");
          expect(ours!.recipe_source).toBe(row.recipeSource);

          expect(IMAGE_TRUST_LEVELS).toContain(ours!.image_trust_level);

          expect(ours!.out_of_band).toBeUndefined();

          const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
          expect(artifact.provenance.recipe_source).toBe(row.recipeSource);
        },
        env.jobTimeoutMs + 60_000
      );
    }
  }
);
