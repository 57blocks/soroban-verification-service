import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import {
  fixtures,
  missingDeployedTarget,
  missingFixture,
  runScopedBldopt,
  submissionFor,
} from "../../support/fixtures.js";
import { expectStatus } from "../../support/http.js";
import { preflight, submitAndWait } from "../../support/job.js";
import { readReportByUrl } from "../../support/result-tree.js";

const OFFICIAL_DOCKER_HUB_PAIRS = [
  "25.1.0/1.90.0",
  "25.2.0/1.90.0",
  "26.0.0/1.94.1",
  "26.1.0/1.96.0",
  "27.0.0/1.95.0",
  "27.0.0/1.96.0",
] as const;

interface PublishedComposedEnvironment {
  kind: string;
  trust_level: string;
  recipe_sha256: string;
  image_digest: string;
  image_reference: string;
  recipe: {
    schema: string;
    pair: { cliver: string; rsver: string };
    template_version: string;
    components: { kind: string; source: string; sha256: string }[];
  };
}

function composedEnvironmentOf(
  buildRecipe: Record<string, unknown> | undefined,
  caseId: string
): PublishedComposedEnvironment {
  const environment = (buildRecipe ?? {})["build_environment"] as
    | Partial<PublishedComposedEnvironment>
    | undefined;

  if (!environment) {
    throw new Error(
      `${caseId}: the report carries no build_recipe.build_environment. A published cli-legacy result ` +
        `must record the environment it was built in (TRD §7.2 criterion 2/3). Got: ` +
        `${JSON.stringify(buildRecipe)?.slice(0, 400)}`
    );
  }
  if (environment.kind !== "composed") {
    throw new Error(
      `${caseId}: the report says the build environment was \`${environment.kind}\`, not \`composed\`. ` +
        `For a contract whose chain metadata names no bldimg that is not a weaker result, it is a ` +
        `different mechanism than the one this case is about — ADR-009 constraint 1 forbids a submitted ` +
        `image from deciding the class, so a \`chain_named\` here means something upstream chose an ` +
        `image it should not have.`
    );
  }
  return environment as PublishedComposedEnvironment;
}

function expectWellFormedComposedEnvironment(
  environment: PublishedComposedEnvironment,
  expected: { cliver?: string; rsver?: string }
): void {
  expect(environment.trust_level).toBe("upstream_pinned");

  expect(environment.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(environment.image_reference).toContain(environment.image_digest);
  expect(environment.recipe_sha256).toMatch(/^[0-9a-f]{64}$/);

  const recipe = environment.recipe;
  expect(recipe.schema).toBe("scvs-composed-environment-v1");
  expect(recipe.template_version).toMatch(/^v\d+$/);
  expect(recipe.components.length).toBeGreaterThan(0);

  for (const component of recipe.components) {
    expect(component.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    if (component.kind === "base_image") {
      expect(component.source).not.toMatch(/^[a-z]+:\/\//);
      expect(component.source).not.toContain("@");
      expect(component.source).toContain("/");
      // Last segment only: a registry host may carry a `:port`.
      expect(component.source.split("/").pop()).not.toContain(":");
    } else {
      expect(component.source).toMatch(/^https:\/\//);
    }
  }

  const kinds = recipe.components.map((component) => component.kind);
  expect(kinds).toContain("rust_toolchain");
  expect(kinds).toContain("stellar_cli");
  expect(kinds.filter((kind) => kind === "base_image")).toHaveLength(1);

  if (expected.cliver) expect(recipe.pair.cliver).toBe(expected.cliver);
  if (expected.rsver) expect(recipe.pair.rsver).toBe(expected.rsver);
}

async function reportViaJobPointer(
  run: { body: { result?: { artifact_url?: string } } },
  caseId: string
) {
  const url = run.body.result?.artifact_url;
  if (!url) {
    throw new Error(
      `${caseId}: the job reported \`verified\` but published no result.artifact_url, so the composed ` +
        `recipe cannot be read from the surface a consumer actually has.`
    );
  }
  return readReportByUrl(url);
}

caseBlock(
  {
    id: "E2E-SUB-02/compose_cache_miss",
    title: "no environment is asked for; one is materialized and the report says what from",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    const CASE_ID = "E2E-SUB-02/compose_cache_miss";
    const target = fixtures.contracts["F-LEG-1"];

    it("the fixture records a pair and no image, and preflight resolves it to `compose`", async () => {
      expect(target.bldimg).toBeUndefined();

      const response = await preflight({
        network: target.network,
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expectStatus(response, 200);

      expect(response.json.build_environment?.kind).toBe("compose");

      expect(response.json.missing_fields ?? []).not.toContain("bldimg");
    });

    it(
      "★ reaches a verdict from a materialized environment whose recipe is fully pinned",
      async () => {
        const run = await submitAndWait(await submissionFor("F-LEG-1"));
        expect(run.body.status).toBe("verified");

        const report = await reportViaJobPointer(run, CASE_ID);
        const environment = composedEnvironmentOf(report.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(environment, {
          cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
          rsver: "1.96.0",
        });

        expect(report.artifact.build_recipe?.build_image).toBe(environment.image_reference);
        expect(String(report.artifact.build_recipe?.build_image)).not.toContain("stellar/stellar-cli");
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

const UNOFFICIAL_PAIR_FIXTURES = [
  {
    fixtureId: "F-COMPOSE-ONLY",
    pair: "25.2.0 / 1.94.0",
    why: "demand rank 2 (10.1%); the first fixture of this kind",
  },
  {
    fixtureId: "F-DEMAND-01",
    pair: "25.1.0 / 1.95.0",
    why: "demand rank 1 — 813 live contracts, 25.2% of live class-B, the largest single combination",
  },
  {
    fixtureId: "F-OLD-END",
    pair: "23.3.0 / 1.91.1",
    why: "the old end: oldest CLI major with real demand (rank 4), and the only fixture below rust 1.94",
  },
] as const;

for (const row of UNOFFICIAL_PAIR_FIXTURES) {
caseBlock(
  {
    id: `E2E-SUB-02/compose_unofficial_pair/${row.fixtureId}`,
    title: `${row.pair} — no official image exists; whole pipeline, twice, to the same digest (${row.why})`,
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget(row.fixtureId),
  },
  () => {
    const CASE_ID = `E2E-SUB-02/compose_unofficial_pair/${row.fixtureId}`;
    const target = fixtures.contracts[row.fixtureId];

    it("the fixture's premise holds: a composable pair that Docker Hub does not publish", async () => {
      expect(target.bldimg).toBeUndefined();

      const response = await preflight({
        network: target.network,
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expectStatus(response, 200);
      expect(response.json.build_environment?.kind).toBe("compose");

      const pair = response.json.build_environment?.intent?.pair;
      expect(pair?.cliver).toEqual(expect.any(String));
      expect(pair?.rsver).toEqual(expect.any(String));

      const shortPair = `${pair.cliver.split("#")[0]}/${pair.rsver}`;
      expect(OFFICIAL_DOCKER_HUB_PAIRS).not.toContain(shortPair);
    });

    it(
      "★ composes an image nobody publishes, rebuilds the deployed bytes with it, and reuses it",
      async () => {
        const first = await submitAndWait(await submissionFor(row.fixtureId));
        expect(first.body.status).toBe("verified");

        const firstReport = await reportViaJobPointer(first, CASE_ID);
        const firstEnvironment = composedEnvironmentOf(firstReport.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(firstEnvironment, {});

        const built = `${firstEnvironment.recipe.pair.cliver.split("#")[0]}/${firstEnvironment.recipe.pair.rsver}`;
        expect(OFFICIAL_DOCKER_HUB_PAIRS).not.toContain(built);

        const second = await submitAndWait(await submissionFor(row.fixtureId));
        expect(second.jobId).not.toBe(first.jobId);
        expect(second.body.status).toBe("verified");

        const secondReport = await reportViaJobPointer(second, CASE_ID);
        const secondEnvironment = composedEnvironmentOf(secondReport.artifact.build_recipe, CASE_ID);

        expect(secondEnvironment.recipe_sha256).toBe(firstEnvironment.recipe_sha256);
        expect(secondEnvironment.image_digest).toBe(firstEnvironment.image_digest);
        expect(secondEnvironment.image_reference).toBe(firstEnvironment.image_reference);
      },
      env.jobTimeoutMs * 2 + 600_000
    );
  }
);
}

const CACHE_HIT_REFERENCE = "F-LEG-1";
const CACHE_HIT_SUBJECT = "F-MULTIPKG";

caseBlock(
  {
    id: "E2E-SUB-02/compose_cache_hit",
    title: "a second contract on the same pair reuses the ready environment",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget(CACHE_HIT_REFERENCE, CACHE_HIT_SUBJECT),
  },
  () => {
    const CASE_ID = "E2E-SUB-02/compose_cache_hit";
    const reference = fixtures.contracts[CACHE_HIT_REFERENCE];
    const subject = fixtures.contracts[CACHE_HIT_SUBJECT];

    it("the two fixtures are different contracts that the *chain* puts on one pair", async () => {
      expect(subject.contract_id).not.toBe(reference.contract_id);
      expect(subject.wasm_hash).not.toBe(reference.wasm_hash);

      expect(reference.bldimg).toBeUndefined();
      expect(subject.bldimg).toBeUndefined();

      const [referencePreflight, subjectPreflight] = await Promise.all([
        preflight({
          network: reference.network,
          contract_id: reference.contract_id,
          wasm_hash: reference.wasm_hash,
        }),
        preflight({
          network: subject.network,
          contract_id: subject.contract_id,
          wasm_hash: subject.wasm_hash,
        }),
      ]);
      expectStatus(referencePreflight, 200);
      expectStatus(subjectPreflight, 200);

      expect(referencePreflight.json.build_environment?.kind).toBe("compose");
      expect(subjectPreflight.json.build_environment?.kind).toBe("compose");
      expect(subjectPreflight.json.build_environment?.kind).toBe(
        referencePreflight.json.build_environment?.kind
      );
      expect(referencePreflight.json.missing_fields ?? []).not.toContain("bldimg");
      expect(subjectPreflight.json.missing_fields ?? []).not.toContain("bldimg");

      const referencePair = referencePreflight.json.build_environment?.intent?.pair;
      const subjectPair = subjectPreflight.json.build_environment?.intent?.pair;
      expect(referencePair?.cliver).toEqual(expect.any(String));
      expect(referencePair?.rsver).toEqual(expect.any(String));
      expect(subjectPair).toEqual(referencePair);
    });

    it(
      "★ the second contract reuses the first one's composed environment",
      async () => {
        const warm = await submitAndWait(await submissionFor(CACHE_HIT_REFERENCE));
        expect(warm.body.status).toBe("verified");

        const readyReport = await reportViaJobPointer(warm, CASE_ID);
        const readyEnvironment = composedEnvironmentOf(readyReport.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(readyEnvironment, {});

        const scopedBldopt = runScopedBldopt(
          subject.bldopt ?? [],
          env.runId,
          expect.getState().currentTestName ?? CASE_ID,
          CACHE_HIT_SUBJECT
        );
        const hit = await submitAndWait(
          await submissionFor(CACHE_HIT_SUBJECT, { bldopt: scopedBldopt })
        );
        expect(hit.jobId).not.toBe(warm.jobId);
        expect(hit.body.status).toBe("verified");

        expect(hit.progressSteps).not.toContain("composing_environment");

        const hitReport = await reportViaJobPointer(hit, CASE_ID);
        const reused = composedEnvironmentOf(hitReport.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(reused, {
          cliver: readyEnvironment.recipe.pair.cliver,
          rsver: readyEnvironment.recipe.pair.rsver,
        });

        expect(reused.recipe_sha256).toBe(readyEnvironment.recipe_sha256);
        expect(reused.image_digest).toBe(readyEnvironment.image_digest);
        expect(reused.image_reference).toBe(readyEnvironment.image_reference);

        expect(hitReport.sha256).not.toBe(readyReport.sha256);
        expect(hit.body.result?.wasm_hash).toBe(subject.wasm_hash);
        expect(hit.body.result?.wasm_hash).not.toBe(warm.body.result?.wasm_hash);

        expect(hitReport.artifact.build_recipe?.build_image).toBe(reused.image_reference);
        expect(String(hitReport.artifact.build_recipe?.build_image)).not.toContain(
          "stellar/stellar-cli"
        );
      },
      env.jobTimeoutMs * 2 + 300_000
    );
  }
);
