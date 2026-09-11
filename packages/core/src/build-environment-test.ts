// Load before anything decorated is evaluated.
import "reflect-metadata";
import assert from "node:assert/strict";
import { validateSync } from "class-validator";
import {
  ComposeIntent,
  CURRENT_COMPOSE_TEMPLATE_VERSION,
  OfficialComponent,
  RecordedToolchainPair,
  classifyBuildEnvironment,
  composedEnvironmentRecipeHash,
  isUndatedNightlyRsver,
  type BuildEnvironmentResolution,
  type ComposedEnvironmentRecipe,
} from "./build-environment.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function recipe(overrides: Partial<ComposedEnvironmentRecipe> = {}): ComposedEnvironmentRecipe {
  return {
    schema: "scvs-composed-environment-v1",
    template_version: "v1",
    pair: { cliver: "25.1.0", rsver: "1.95.0" },
    components: [
      { kind: "base_image", source: "docker.io/library/debian@sha256:" + "a".repeat(64), sha256: "sha256:" + "a".repeat(64) },
      { kind: "rust_toolchain", source: "https://static.rust-lang.org/dist/rust-1.95.0.tar.gz", sha256: "sha256:" + "b".repeat(64) },
      { kind: "stellar_cli", source: "https://github.com/stellar/stellar-cli/releases/download/v25.1.0/stellar-cli", sha256: "sha256:" + "c".repeat(64) },
    ],
    ...overrides,
  } as ComposedEnvironmentRecipe;
}

test("Recipe hash is stable across component reordering", () => {
  const a = recipe();
  const b = recipe({ components: [...recipe().components].reverse() });
  assert.equal(composedEnvironmentRecipeHash(a), composedEnvironmentRecipeHash(b));
});

test("Recipe hash changes when any pinned field changes", () => {
  const base = composedEnvironmentRecipeHash(recipe());

  assert.notEqual(base, composedEnvironmentRecipeHash(recipe({ template_version: "v2" })));
  assert.notEqual(
    base,
    composedEnvironmentRecipeHash(recipe({ pair: { cliver: "25.1.0", rsver: "1.96.0" } })),
  );

  const withDifferentChecksum = recipe();
  withDifferentChecksum.components[1].sha256 = "sha256:" + "9".repeat(64);
  assert.notEqual(base, composedEnvironmentRecipeHash(withDifferentChecksum));
});

test("OfficialComponent: runtime_library is an accepted kind, and an invented kind still is not", () => {
  // The negative half is the point of the test: the union is a published wire contract, and a typo'd kind must
  // fail validation rather than reach a recipe.
  const good = Object.assign(new OfficialComponent(), {
    kind: "runtime_library",
    source: "https://snapshot.debian.org/archive/debian/20230924T084440Z/pool/main/d/dbus/libdbus.deb",
    sha256: "sha256:" + "d".repeat(64),
  });
  assert.deepEqual(validateSync(good), []);

  const bogus = Object.assign(new OfficialComponent(), {
    kind: "runtime_libraries",
    source: "https://example.com/x.deb",
    sha256: "sha256:" + "d".repeat(64),
  });
  assert.equal(validateSync(bogus).length > 0, true);
});

test("Recipe hash sorts a second component of the same kind by source, not by insertion order", () => {
  // `kind` alone stopped being a total order when `runtime_library` arrived.
  const libA = {
    kind: "runtime_library" as const,
    source: "https://a.example/a.deb",
    sha256: "sha256:" + "d".repeat(64),
  };
  const libB = {
    kind: "runtime_library" as const,
    source: "https://b.example/b.deb",
    sha256: "sha256:" + "e".repeat(64),
  };
  const withLibraries = (libraries: OfficialComponent[]): ComposedEnvironmentRecipe =>
    recipe({ components: [...recipe().components, ...libraries] });

  assert.equal(
    composedEnvironmentRecipeHash(withLibraries([libA, libB])),
    composedEnvironmentRecipeHash(withLibraries([libB, libA])),
  );
});

test("Recipe hash of an existing three-component recipe is unchanged by the source tie-break", () => {
  // The tie-break must not have moved any already-published identity.
  assert.equal(
    composedEnvironmentRecipeHash(recipe()),
    "3758a19a2cd70a433ffe1f564e94c6b76f38f354ec4c11eaa27edae7c0461f61",
  );
});

test("Recipe hash does not collide across a field-boundary shift (length-prefixing check)", () => {
  // Guards against a naive concatenation scheme where e.g. a longer `template_version` and a shorter `cliver`
  // could produce the same byte string as the reverse split.
  const a = recipe({ template_version: "ab", pair: { cliver: "c", rsver: "1.95.0" } });
  const b = recipe({ template_version: "a", pair: { cliver: "bc", rsver: "1.95.0" } });
  assert.notEqual(composedEnvironmentRecipeHash(a), composedEnvironmentRecipeHash(b));
});

test("isUndatedNightlyRsver: matches every nightly marker the 2026-07-30 corpus scan found", () => {
  for (const rsver of [
    "1.90.0-nightly",
    "1.91.0-nightly",
    "1.94.0-nightly",
    "1.95.0-nightly",
    "1.96.0-nightly",
  ]) {
    assert.equal(isUndatedNightlyRsver(rsver), true, rsver);
  }
});

test("isUndatedNightlyRsver: does not flag an ordinary released version", () => {
  for (const rsver of ["1.95.0", "1.81.0", "1.96.1"]) {
    assert.equal(isUndatedNightlyRsver(rsver), false, rsver);
  }
});

function toolchainPair(cliver: string, rsver: string): RecordedToolchainPair {
  const pair = new RecordedToolchainPair();
  pair.cliver = cliver;
  pair.rsver = rsver;
  return pair;
}

test("ComposeIntent: validates with a pair and a template_version, nothing else required", () => {
  const intent = new ComposeIntent();
  intent.pair = toolchainPair("25.1.0", "1.95.0");
  intent.template_version = "v1";
  assert.deepEqual(validateSync(intent), []);
});

test("ComposeIntent: rejects a missing template_version rather than defaulting one silently", () => {
  const intent = new ComposeIntent();
  intent.pair = toolchainPair("25.1.0", "1.95.0");
  // @ts-expect-error -- exercising the missing-field case on purpose
  intent.template_version = undefined;
  assert.notEqual(validateSync(intent).length, 0);
});

test("ComposeIntent: rejects an absent pair, which @ValidateNested alone would let through", () => {
  // See `ComposeIntent.pair`'s comment.
  const intent = new ComposeIntent();
  intent.template_version = "v1";
  // @ts-expect-error -- exercising the missing-field case on purpose
  intent.pair = undefined;
  assert.notEqual(validateSync(intent).length, 0);
});

test("BuildEnvironmentResolution: the compose case carries an intent, never a populated recipe", () => {
  // If a future edit widens `compose` back to carrying a full `ComposedEnvironmentRecipe`, this assignment
  // stops compiling.
  const resolution: BuildEnvironmentResolution = {
    kind: "compose",
    intent: { pair: { cliver: "25.1.0", rsver: "1.95.0" }, template_version: "v1" },
    trustLevel: "upstream_pinned",
  };
  assert.equal(resolution.kind, "compose");
});

test("classifyBuildEnvironment: a policy-checked image always wins, even alongside a pair", () => {
  const resolution = classifyBuildEnvironment({
    policyCheckedImage: "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64),
    pair: { cliver: "25.1.0", rsver: "1.95.0" },
  });
  assert.equal(resolution.kind, "chain_named");
});

test("classifyBuildEnvironment: no image and no pair is missing_toolchain_pair (cli-none)", () => {
  assert.deepEqual(classifyBuildEnvironment({}), {
    kind: "unsupported",
    reason: "missing_toolchain_pair",
  });
});

test("classifyBuildEnvironment: an undated nightly pair is undated_nightly, never compose", () => {
  const resolution = classifyBuildEnvironment({
    pair: { cliver: "25.1.0", rsver: "1.95.0-nightly" },
  });
  assert.deepEqual(resolution, { kind: "unsupported", reason: "undated_nightly" });
});

test("classifyBuildEnvironment: every addressable cli-legacy pair resolves to a compose intent", () => {
  const pair = {
    cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
    rsver: "1.96.0",
  };
  assert.deepEqual(classifyBuildEnvironment({ pair }), {
    kind: "compose",
    intent: { pair, template_version: CURRENT_COMPOSE_TEMPLATE_VERSION },
    trustLevel: "upstream_pinned",
  });
});

console.log("build-environment: all cases passed");
