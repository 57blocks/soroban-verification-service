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
import { HEX_SHA256, PREFIXED_SHA256 } from "./digest.js";

export class ComposerJobParams {
  @IsString() environment_id!: string;
  /** `@ValidateNested()` alone passes an absent value; `@IsDefined()` rejects a missing pair. */
  @IsDefined() @ValidateNested() @Type(() => RecordedToolchainPair) pair!: RecordedToolchainPair;
  @IsString() template_version!: string;
  @IsString() ecr_repository_uri!: string;
  @IsString() upload_url!: string;
}

export class ComposerSmokeTest {
  @IsString() reported_cliver!: string;
  @IsString() reported_rsver!: string;
  @IsBoolean() matches_pair!: boolean;
}

const composerClassifications = ["success", "composition_failure"] as const;

export class ComposerArtifact {
  @Equals("scvs-composer-artifact-v1") schema!: "scvs-composer-artifact-v1";
  @IsString() environment_id!: string;
  @IsIn(composerClassifications) classification!: (typeof composerClassifications)[number];
  @IsString() composed_at!: string;

  @IsOptional() @Matches(HEX_SHA256) recipe_sha256?: string;
  @IsOptional() @Matches(PREFIXED_SHA256) image_digest?: string;
  @IsOptional() @IsString() image_architecture?: string;
  @IsOptional() @ValidateNested() @Type(() => ComposedEnvironmentRecipe)
  recipe?: ComposedEnvironmentRecipe;
  @IsOptional() @ValidateNested() @Type(() => ComposerSmokeTest) smoke_test?: ComposerSmokeTest;

  @IsOptional() @IsString() reason?: string;
  @IsOptional() failure_context?: Record<string, unknown>;
}


export function composedEnvironmentImageReference(
  ecrRepositoryUri: string,
  imageDigest: string,
): string {
  if (!PREFIXED_SHA256.test(imageDigest)) {
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

const PERMANENT_COMPOSITION_FAILURES: ReadonlySet<string> = new Set([
  "unreleased_cli",
  "unaddressable_cliver",
  "asset_digest_unavailable",
  "ambiguous_release_asset",
  "smoke_test_disagreed",
  "composer_smoke_test_disagreed",
  "component_checksum_mismatch",
  "toolchain_target_unavailable",
  "composer_receipt_wrong_pair",
  "composer_recipe_hash_mismatch",
]);

export function isPermanentCompositionFailure(reason: string | undefined): boolean {
  return reason !== undefined && PERMANENT_COMPOSITION_FAILURES.has(reason);
}
