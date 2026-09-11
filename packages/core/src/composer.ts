import { Type } from "class-transformer";
import {
  Equals,
  IsBoolean,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator";
import { ComposedEnvironmentRecipe, RecordedToolchainPair } from "./build-environment.js";

// The orchestrator↔composer wire contract — the composition half of what `batch.ts` is for the builder.

/** What `ComposerDispatchService` hands one `scvs-composer` Batch job. */
export class ComposerJobParams {
  /** The `Environment` row this composition belongs to — correlation, and the receipt's key. */
  @IsString() environment_id!: string;
  /**
   * `@IsDefined()` is load-bearing, not redundant: `@ValidateNested()` alone validates a nested object's
   * *contents* and silently passes when the value is absent entirely, so without this a `ComposerJobParams`
   * missing its pair would validate clean and the composer would be asked to build an unspecified toolchain.
   */
  @IsDefined() @ValidateNested() @Type(() => RecordedToolchainPair) pair!: RecordedToolchainPair;
  /** Verifier-owned; selects which composition template runs. */
  @IsString() template_version!: string;
  /** The private ECR repository to push the composed image to — e.g. */
  @IsString() ecr_repository_uri!: string;
  /** Presigned PUT for `staging/environments/{environment_id}/composer.json`. */
  @IsString() upload_url!: string;
}

/** What the composer observed by running the finished image, before it was allowed to push. */
export class ComposerSmokeTest {
  /** `stellar version`'s complete reported output, as read inside the built image. */
  @IsString() reported_cliver!: string;
  /** `rustc --version`'s reported version, as read inside the built image. */
  @IsString() reported_rsver!: string;
  /** Whether both agree with the pair this composition was asked to produce. */
  @IsBoolean() matches_pair!: boolean;
}

const composerClassifications = ["success", "composition_failure"] as const;

/** Do not let this artifact regress into carrying a bare classification. */
export class ComposerArtifact {
  @Equals("scvs-composer-artifact-v1") schema!: "scvs-composer-artifact-v1";
  @IsString() environment_id!: string;
  @IsIn(composerClassifications) classification!: (typeof composerClassifications)[number];
  @IsString() composed_at!: string;

  /** The published immutable identity — `composedEnvironmentRecipeHash(recipe)`. Success only. */
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) recipe_sha256?: string;
  /** The pushed image's own OCI digest in our ECR repository. Success only. */
  @IsOptional() @Matches(/^sha256:[0-9a-f]{64}$/) image_digest?: string;
  /** The architecture the pushed image declares, read from its own config. Success only. */
  @IsOptional() @IsString() image_architecture?: string;
  /** The full recipe `recipe_sha256` is the hash of. Success only. */
  @IsOptional() @ValidateNested() @Type(() => ComposedEnvironmentRecipe)
  recipe?: ComposedEnvironmentRecipe;
  @IsOptional() @ValidateNested() @Type(() => ComposerSmokeTest) smoke_test?: ComposerSmokeTest;

  /** Machine-readable failure code. */
  @IsOptional() @IsString() reason?: string;
  /**
   * Small, unstructured context for `reason` — a resolved URL, an expected-vs-actual checksum pair, a `detail`
   * sentence; never bulky command output.
   */
  @IsOptional() failure_context?: Record<string, unknown>;
}

const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Builds the digest-pinned pull reference for a cli-legacy rebuild — `<repository-uri>@sha256:<64 hex>`. */
export function composedEnvironmentImageReference(
  ecrRepositoryUri: string,
  imageDigest: string,
): string {
  if (!IMAGE_DIGEST_RE.test(imageDigest)) {
    throw new Error(
      `A composed environment must be referenced by digest, got ${JSON.stringify(imageDigest)}. ` +
        "Expected sha256:<64 lowercase hex chars>.",
    );
  }
  if (ecrRepositoryUri.includes("@") || ecrRepositoryUri.includes(" ")) {
    throw new Error(
      `The composed-environment repository URI must be a bare repository, got ${JSON.stringify(ecrRepositoryUri)}.`,
    );
  }
  return `${ecrRepositoryUri}@${imageDigest}`;
}

/** Composition failure reasons that are a property of the **pair**, not the attempt — retrying changes nothing. */
const PERMANENT_COMPOSITION_FAILURES: ReadonlySet<string> = new Set([
  // No such stellar-cli release exists — the `unreleased_cli` case the resolver cannot classify for want of
  // this data source.
  "unreleased_cli",
  // The recorded `cliver` is not usable as a release tag at all.
  "unaddressable_cliver",
  // The release publishes no official checksum for its asset, so its bytes cannot be verified.
  "asset_digest_unavailable",
  // Our asset-matching rule cannot disambiguate this release. Actionable by us, but not by retrying.
  "ambiguous_release_asset",
  // The composer refuses to push; a retry produces the same image.
  "smoke_test_disagreed",
  "composer_smoke_test_disagreed",
  // An official component's bytes did not match the checksum its own official channel publishes.
  "component_checksum_mismatch",
  // The recorded `rsver`'s toolchain does not distribute a Rust target the template pins, measured against
  // rustup's channel manifest before anything is built (`components.ts` `assertToolchainProvidesTargets`).
  "toolchain_target_unavailable",
  // The composer contradicted itself or reported something unusable. Not the submitter's to retry.
  "composer_receipt_wrong_pair",
  "composer_recipe_hash_mismatch",
]);

/** Whether a composition failure will still fail if asked again. */
export function isPermanentCompositionFailure(reason: string | undefined): boolean {
  return reason !== undefined && PERMANENT_COMPOSITION_FAILURES.has(reason);
}
