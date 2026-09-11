/** E2E-SUB-02 — direct composition */
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

/**
 * Written down here so `compose_unofficial_pair` can assert its own premise: a fixture that quietly moved onto
 * an official pair would still pass every other assertion in the case while no longer testing anything the
 * first case does not already cover.
 */
const OFFICIAL_DOCKER_HUB_PAIRS = [
  "25.1.0/1.90.0",
  "25.2.0/1.90.0",
  "26.0.0/1.94.1",
  "26.1.0/1.96.0",
  "27.0.0/1.95.0",
  "27.0.0/1.96.0",
] as const;

/** The composed half of `PublishedBuildEnvironment`, as `artifact-builder.util.ts` publishes it. */
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

/** Pulls the composed environment out of a report, refusing anything else. */
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

/** Every assertion that is true of any composed environment, whatever the pair. */
function expectWellFormedComposedEnvironment(
  environment: PublishedComposedEnvironment,
  expected: { cliver?: string; rsver?: string }
): void {
  // `sdf_trusted` is what a chain-named official image gets and must never appear on a composed one.
  expect(environment.trust_level).toBe("upstream_pinned");

  // A tag here would mean the published result cannot identify the bytes that built it.
  expect(environment.image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(environment.image_reference).toContain(environment.image_digest);
  expect(environment.recipe_sha256).toMatch(/^[0-9a-f]{64}$/);

  const recipe = environment.recipe;
  expect(recipe.schema).toBe("scvs-composed-environment-v1");
  expect(recipe.template_version).toMatch(/^v\d+$/);
  expect(recipe.components.length).toBeGreaterThan(0);

  // It failed on the real recipe with `docker.io/library/buildpack-deps`.
  for (const component of recipe.components) {
    expect(component.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    if (component.kind === "base_image") {
      // The one property that matters: **bare**. Checked on the final path segment so a registry host carrying
      // a port is not mistaken for a tag.
      expect(component.source).not.toMatch(/^[a-z]+:\/\//);
      expect(component.source).not.toContain("@");
      expect(component.source).toContain("/");
      expect(component.source.split("/").pop()).not.toContain(":");
    } else {
      expect(component.source).toMatch(/^https:\/\//);
    }
  }

  // A recipe that pins no toolchain and no CLI does not describe a build environment.
  const kinds = recipe.components.map((component) => component.kind);
  expect(kinds).toContain("rust_toolchain");
  expect(kinds).toContain("stellar_cli");
  expect(kinds.filter((kind) => kind === "base_image")).toHaveLength(1);

  // A silent substitution is precisely the defect that would make a `verified` verdict meaningless.
  if (expected.cliver) expect(recipe.pair.cliver).toBe(expected.cliver);
  if (expected.rsver) expect(recipe.pair.rsver).toBe(expected.rsver);
}

/** Reads the report through the job's own pointer. */
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
      // Step 1 is a statement about the fixture, and it is worth asserting rather than trusting: a fixture that
      // grew a `bldimg` would make this a cli-58 case wearing a cli-legacy name, and every later assertion
      // would still pass.
      expect(target.bldimg).toBeUndefined();

      const response = await preflight({
        network: target.network,
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expectStatus(response, 200);

      // Step 2. `compose` is the *intent* spelling — see the header note on the two vocabularies.
      expect(response.json.build_environment?.kind).toBe("compose");

      expect(response.json.missing_fields ?? []).not.toContain("bldimg");
    });

    it(
      "★ reaches a verdict from a materialized environment whose recipe is fully pinned",
      async () => {
        // Step 3 — the submission carries no environment field. `submissionFor` passes `bldimg` only when the
        // fixture names one, and this fixture does not.
        const run = await submitAndWait(await submissionFor("F-LEG-1"));
        expect(run.body.status).toBe("verified");

        // Step 4.
        const report = await reportViaJobPointer(run, CASE_ID);
        const environment = composedEnvironmentOf(report.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(environment, {
          // From registry.yaml's purpose_testnet_f_leg_1 — the pair the deployed Wasm records.
          cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
          rsver: "1.96.0",
        });

        // The submitted body named no image, so the recipe's own image is the only one in play.
        expect(report.artifact.build_recipe?.build_image).toBe(environment.image_reference);
        expect(String(report.artifact.build_recipe?.build_image)).not.toContain("stellar/stellar-cli");
      },
      env.jobTimeoutMs + 120_000
    );
  }
);

/** The unofficial-pair fixtures, one row each. */
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

      // The `compose` arm of preflight's response schema carries a `ComposeIntent`, whose `pair` is the pair
      // read out of `contractmetav0` — the same value the materializer will compose against.
      const pair = response.json.build_environment?.intent?.pair;
      expect(pair?.cliver).toEqual(expect.any(String));
      expect(pair?.rsver).toEqual(expect.any(String));

      const shortPair = `${pair.cliver.split("#")[0]}/${pair.rsver}`;
      expect(OFFICIAL_DOCKER_HUB_PAIRS).not.toContain(shortPair);
    });

    it(
      "★ composes an image nobody publishes, rebuilds the deployed bytes with it, and reuses it",
      async () => {
        // ── First submission: cache miss ────────────────────────────────────────────────────────
        // Nothing has ever composed this pair on this deployment, so this run is the whole claim: the
        // components have never been shipped together and the pipeline still reaches a verdict.
        const first = await submitAndWait(await submissionFor(row.fixtureId));
        expect(first.body.status).toBe("verified");

        const firstReport = await reportViaJobPointer(first, CASE_ID);
        const firstEnvironment = composedEnvironmentOf(firstReport.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(firstEnvironment, {});

        // Same premise as the preflight test, now against the *published* recipe — the record a third party
        // would reproduce from.
        const built = `${firstEnvironment.recipe.pair.cliver.split("#")[0]}/${firstEnvironment.recipe.pair.rsver}`;
        expect(OFFICIAL_DOCKER_HUB_PAIRS).not.toContain(built);

        // ── Second submission: reuse ────────────────────────────────────────────────────────────
        // The documented `compose_cache_hit` expectation is "exactly one environment row and no second composer
        // job", which is internal state a black-box run cannot see.
        const second = await submitAndWait(await submissionFor(row.fixtureId));
        expect(second.jobId).not.toBe(first.jobId);
        expect(second.body.status).toBe("verified");

        const secondReport = await reportViaJobPointer(second, CASE_ID);
        const secondEnvironment = composedEnvironmentOf(secondReport.artifact.build_recipe, CASE_ID);

        expect(secondEnvironment.recipe_sha256).toBe(firstEnvironment.recipe_sha256);
        expect(secondEnvironment.image_digest).toBe(firstEnvironment.image_digest);
        expect(secondEnvironment.image_reference).toBe(firstEnvironment.image_reference);
      },
      // Two full verifications, the first including a composition from scratch: fetching a Rust toolchain and a
      // CLI release, building an image, pushing it, then two sandboxed rebuilds.
      env.jobTimeoutMs * 2 + 600_000
    );
  }
);
}

/** E2E-SUB-02/compose_cache_hit */
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
      // A same-target retry cannot prove that the cache is keyed by the toolchain pair.
      expect(subject.contract_id).not.toBe(reference.contract_id);
      expect(subject.wasm_hash).not.toBe(reference.wasm_hash);

      // A chain-named image would bypass the cli-legacy composition path.
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

      // Cache state is not a submitter choice; both targets must resolve to the same compose intent.
      expect(referencePreflight.json.build_environment?.kind).toBe("compose");
      expect(subjectPreflight.json.build_environment?.kind).toBe("compose");
      expect(subjectPreflight.json.build_environment?.kind).toBe(
        referencePreflight.json.build_environment?.kind
      );
      expect(referencePreflight.json.missing_fields ?? []).not.toContain("bldimg");
      expect(subjectPreflight.json.missing_fields ?? []).not.toContain("bldimg");

      // Read the pair from chain-derived preflight, not the mutable fixture inventory.
      const referencePair = referencePreflight.json.build_environment?.intent?.pair;
      const subjectPair = subjectPreflight.json.build_environment?.intent?.pair;
      expect(referencePair?.cliver).toEqual(expect.any(String));
      expect(referencePair?.rsver).toEqual(expect.any(String));
      expect(subjectPair).toEqual(referencePair);
    });

    it(
      "★ the second contract reuses the first one's composed environment",
      async () => {
        // F-LEG-1's run-scoped recipe forces a current job instead of historical-result adoption.
        const warm = await submitAndWait(await submissionFor(CACHE_HIT_REFERENCE));
        expect(warm.body.status).toBe("verified");

        const readyReport = await reportViaJobPointer(warm, CASE_ID);
        const readyEnvironment = composedEnvironmentOf(readyReport.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(readyEnvironment, {});

        // Keep F-MULTIPKG deduplicable elsewhere, but force a fresh job in this case.
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

        // This is sampled status evidence, not a durable audit of every transition.
        expect(hit.progressSteps).not.toContain("composing_environment");

        const hitReport = await reportViaJobPointer(hit, CASE_ID);
        const reused = composedEnvironmentOf(hitReport.artifact.build_recipe, CASE_ID);
        expectWellFormedComposedEnvironment(reused, {
          cliver: readyEnvironment.recipe.pair.cliver,
          rsver: readyEnvironment.recipe.pair.rsver,
        });

        // Recipe identity, image bytes, and Batch's pull reference must all be reused.
        expect(reused.recipe_sha256).toBe(readyEnvironment.recipe_sha256);
        expect(reused.image_digest).toBe(readyEnvironment.image_digest);
        expect(reused.image_reference).toBe(readyEnvironment.image_reference);

        // A report-pointer mix-up must not turn the reference report into a false cache hit.
        expect(hitReport.sha256).not.toBe(readyReport.sha256);
        expect(hit.body.result?.wasm_hash).toBe(subject.wasm_hash);
        expect(hit.body.result?.wasm_hash).not.toBe(warm.body.result?.wasm_hash);

        // cli-legacy must use the composed image even when Docker Hub offers the same pair.
        expect(hitReport.artifact.build_recipe?.build_image).toBe(reused.image_reference);
        expect(String(hitReport.artifact.build_recipe?.build_image)).not.toContain(
          "stellar/stellar-cli"
        );
      },
      // The first verification may also materialize the environment.
      env.jobTimeoutMs * 2 + 300_000
    );
  }
);
