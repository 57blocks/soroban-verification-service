// Required before any decorated class is evaluated — see `build-environment-test.ts`'s own note.
import "reflect-metadata";
import assert from "node:assert/strict";
import { validateSync } from "class-validator";
import {
  ComposerArtifact,
  ComposerJobParams,
  composedEnvironmentImageReference,
  isPermanentCompositionFailure,
} from "./composer.js";
import { RecordedToolchainPair } from "./build-environment.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const ECR = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/scvs-composed-environments";
const DIGEST = "sha256:" + "a".repeat(64);

function pair(cliver = "25.1.0", rsver = "1.95.0"): RecordedToolchainPair {
  const value = new RecordedToolchainPair();
  value.cliver = cliver;
  value.rsver = rsver;
  return value;
}

function composerParams(): ComposerJobParams {
  const params = new ComposerJobParams();
  params.environment_id = "11111111-1111-1111-1111-111111111111";
  params.pair = pair();
  params.template_version = "v1";
  params.ecr_repository_uri = ECR;
  params.upload_url = "https://example.s3.amazonaws.com/staging/environments/x/composer.json?sig=1";
  return params;
}

test("ComposerJobParams validates with only chain-derived and verifier-owned fields", () => {
  assert.deepEqual(validateSync(composerParams()), []);
});

test("CE1: ComposerJobParams has no field capable of carrying submission data", () => {
  // Enforcing that by *shape* rather than by call-site discipline is the point — a submitted value cannot
  // travel through a field that does not exist.
  assert.deepEqual(Object.keys(composerParams()).sort(), [
    "ecr_repository_uri",
    "environment_id",
    "pair",
    "template_version",
    "upload_url",
  ]);

  for (const forbidden of [
    "source_ref",
    "source_uri",
    "source_sha256",
    "upload_id",
    "target",
    "build_args",
    "build_options",
    "bldarg",
    "bldopt",
    "bldimg",
    "manifest",
    "metadata_replay",
    "components", // a caller-supplied component set would be a checksum override in disguise
  ]) {
    assert.equal(
      forbidden in composerParams(),
      false,
      `ComposerJobParams must never carry ${forbidden} — see ADR-017 §6 and this test's comment.`,
    );
  }
});

test("ComposerJobParams rejects a missing pair rather than composing an unspecified toolchain", () => {
  const params = composerParams();
  // @ts-expect-error -- exercising the missing-field case on purpose
  params.pair = undefined;
  assert.notEqual(validateSync(params).length, 0);
});

test("ComposerArtifact validates a success receipt carrying all three identities", () => {
  const artifact = new ComposerArtifact();
  artifact.schema = "scvs-composer-artifact-v1";
  artifact.environment_id = "11111111-1111-1111-1111-111111111111";
  artifact.classification = "success";
  artifact.composed_at = new Date(0).toISOString();
  artifact.recipe_sha256 = "b".repeat(64);
  artifact.image_digest = DIGEST;
  assert.deepEqual(validateSync(artifact), []);
});

test("ComposerArtifact rejects a recipe_sha256 that is not a bare 64-hex digest", () => {
  const artifact = new ComposerArtifact();
  artifact.schema = "scvs-composer-artifact-v1";
  artifact.environment_id = "e";
  artifact.classification = "success";
  artifact.composed_at = new Date(0).toISOString();
  // The recipe hash is a bare hex digest, unlike image_digest's `sha256:`-prefixed OCI form.
  artifact.recipe_sha256 = DIGEST;
  assert.notEqual(validateSync(artifact).length, 0);
});

test("ComposerArtifact rejects an unknown schema string", () => {
  const artifact = new ComposerArtifact();
  // @ts-expect-error -- exercising the wrong-schema case on purpose
  artifact.schema = "scvs-composer-artifact-v2";
  artifact.environment_id = "e";
  artifact.classification = "success";
  artifact.composed_at = new Date(0).toISOString();
  assert.notEqual(validateSync(artifact).length, 0);
});

test("composedEnvironmentImageReference builds the digest-pinned pull reference", () => {
  assert.equal(composedEnvironmentImageReference(ECR, DIGEST), `${ECR}@${DIGEST}`);
});

test("composedEnvironmentImageReference refuses a tag, a bare hash, or an already-pinned repository", () => {
  assert.throws(() => composedEnvironmentImageReference(ECR, "v1.0.0"), /referenced by digest/);
  assert.throws(() => composedEnvironmentImageReference(ECR, "a".repeat(64)), /referenced by digest/);
  assert.throws(
    () => composedEnvironmentImageReference(ECR, "sha256:" + "A".repeat(64)),
    /referenced by digest/,
  );
  assert.throws(
    () => composedEnvironmentImageReference(`${ECR}@${DIGEST}`, DIGEST),
    /bare repository/,
  );
});

test("isPermanentCompositionFailure: pair-intrinsic failures are permanent", () => {
  // These are properties of the recorded `(cliver, rsver)`, not of the attempt: no such release exists, the
  // built image reports a different toolchain, an official component failed its own published checksum.
  for (const reason of [
    "unreleased_cli",
    "unaddressable_cliver",
    "asset_digest_unavailable",
    "ambiguous_release_asset",
    "smoke_test_disagreed",
    "composer_smoke_test_disagreed",
    "component_checksum_mismatch",
    "composer_receipt_wrong_pair",
    "composer_recipe_hash_mismatch",
    // The toolchain does not ship a target the template pins. Retrying composes the same template for the same
    // pair, so it cannot end differently.
    "toolchain_target_unavailable",
  ]) {
    assert.equal(isPermanentCompositionFailure(reason), true, `${reason} should be permanent`);
  }
});

test("isPermanentCompositionFailure: infrastructure failures are ours, and retryable", () => {
  for (const reason of [
    "component_unreachable",
    "image_build_failed",
    "ecr_push_failed",
    "receipt_upload_failed",
  ]) {
    assert.equal(isPermanentCompositionFailure(reason), false, `${reason} should be retryable`);
  }
});

test("isPermanentCompositionFailure: a missing Rust target is not the same bucket as a failed build", () => {
  // `image_build_failed` means only "docker build exited non-zero", which a registry hiccup or a full disk also
  // produces, so it stays retryable.
  assert.equal(isPermanentCompositionFailure("toolchain_target_unavailable"), true);
  assert.equal(isPermanentCompositionFailure("image_build_failed"), false);
});

test("isPermanentCompositionFailure: an unknown reason defaults to retryable, not permanent", () => {
  // A new composer failure code added later must not silently start telling submitters their contract can never
  // be verified — the honest default is "our problem".
  assert.equal(isPermanentCompositionFailure("some_reason_added_next_quarter"), false);
});

test("isPermanentCompositionFailure: an absent reason is not permanent", () => {
  // A `composition_failure` receipt whose `reason` never arrived is a receipt bug, not evidence about the pair.
  assert.equal(isPermanentCompositionFailure(undefined), false);
  assert.equal(isPermanentCompositionFailure(""), false);
});

test("isPermanentCompositionFailure: reason matching is exact, not prefix or case-insensitive", () => {
  // The wire value comes straight from the composer's receipt; a near-miss must fail to the retryable side
  // rather than be guessed at.
  for (const near of ["unreleased_cli ", "UNRELEASED_CLI", "unreleased", "unreleased_cli_v2"]) {
    assert.equal(isPermanentCompositionFailure(near), false, `${JSON.stringify(near)} should not match`);
  }
});

console.log("composer: all cases passed");
