import { Type } from "class-transformer";
import {
  Equals,
  IsArray,
  IsDefined,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { IMAGE_TRUST_LEVELS, type ImageTrustLevel } from "./registry.js";
import { HEX_SHA256, PREFIXED_SHA256 } from "./digest.js";

export class RecordedToolchainPair {
  @IsString() cliver!: string;
  @IsString() rsver!: string;
}

export class OfficialComponent {
  @IsIn(["rust_toolchain", "stellar_cli", "base_image", "runtime_library"]) kind!:
    | "rust_toolchain"
    | "stellar_cli"
    | "base_image"
    | "runtime_library";
  @IsString() source!: string;
  @Matches(PREFIXED_SHA256) sha256!: string;
}

export class ComposedEnvironmentRecipe {
  @Equals("scvs-composed-environment-v1") schema!: "scvs-composed-environment-v1";
  // `@ValidateNested()` passes an absent value, so `@IsDefined()`/`@IsArray()` are required beside it.
  @IsDefined() @ValidateNested() @Type(() => RecordedToolchainPair) pair!: RecordedToolchainPair;
  @IsString() template_version!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OfficialComponent)
  components!: OfficialComponent[];
}

export class BuildEnvironmentRecord {
  @IsIn(["chain_named", "composed"]) kind!: "chain_named" | "composed";
  @IsIn(IMAGE_TRUST_LEVELS) trust_level!: ImageTrustLevel;
  @IsString() image_reference!: string;

  @ValidateIf((o: BuildEnvironmentRecord) => o.kind === "composed")
  @Matches(HEX_SHA256)
  recipe_sha256?: string;

  @ValidateIf((o: BuildEnvironmentRecord) => o.kind === "composed")
  @Matches(PREFIXED_SHA256)
  image_digest?: string;

  @ValidateIf((o: BuildEnvironmentRecord) => o.kind === "composed")
  @IsDefined()
  @ValidateNested()
  @Type(() => ComposedEnvironmentRecipe)
  recipe?: ComposedEnvironmentRecipe;
}

export class PublishedBuildRecipe {
  @IsString() build_image!: string;
  @ValidateNested() @Type(() => BuildEnvironmentRecord) build_environment!: BuildEnvironmentRecord;
  @IsOptional() @IsObject() build_options?: Record<string, unknown>;
}

export class ComposeIntent {
  @IsDefined() @ValidateNested() @Type(() => RecordedToolchainPair) pair!: RecordedToolchainPair;
  @IsString() template_version!: string;
}

export const CURRENT_COMPOSE_TEMPLATE_VERSION = "v3";

export type UnsupportedToolchainReason =
  | "unreleased_cli"
  | "undated_nightly"
  | "missing_toolchain_pair";

export type BuildEnvironmentResolution =
  | { kind: "chain_named"; image: string; trustLevel: "sdf_trusted" }
  | { kind: "compose"; intent: ComposeIntent; trustLevel: "upstream_pinned" }
  | { kind: "unsupported"; reason: UnsupportedToolchainReason };

const UNDATED_NIGHTLY_RE = /-nightly$/i;

export function isUndatedNightlyRsver(rsver: string): boolean {
  return UNDATED_NIGHTLY_RE.test(rsver);
}

export function classifyBuildEnvironment(input: {
  /** Must already have been accepted by `evaluateBuildImage()`. */
  policyCheckedImage?: string;
  pair?: RecordedToolchainPair;
}): BuildEnvironmentResolution {
  if (input.policyCheckedImage !== undefined) {
    return { kind: "chain_named", image: input.policyCheckedImage, trustLevel: "sdf_trusted" };
  }

  if (input.pair === undefined) {
    return { kind: "unsupported", reason: "missing_toolchain_pair" };
  }

  if (isUndatedNightlyRsver(input.pair.rsver)) {
    return { kind: "unsupported", reason: "undated_nightly" };
  }

  return {
    kind: "compose",
    intent: { pair: input.pair, template_version: CURRENT_COMPOSE_TEMPLATE_VERSION },
    trustLevel: "upstream_pinned",
  };
}

export const buildArchitectures = ["arm64", "amd64"] as const;

export type BuildArchitecture = (typeof buildArchitectures)[number];

export function isBuildArchitecture(value: unknown): value is BuildArchitecture {
  return typeof value === "string" && (buildArchitectures as readonly string[]).includes(value);
}

export type MaterializedEnvironment = {
  recipeSha256: string;
  imageDigest: string;
  recipe: ComposedEnvironmentRecipe;
  arch?: BuildArchitecture;
};

export type MaterializationResult =
  | { kind: "ready"; environmentId: string; environment: MaterializedEnvironment }
  | { kind: "composing"; environmentId: string }
  | { kind: "failed"; environmentId: string; errorCode: string };

export type RebuildEnvironmentIdentity =
  | { kind: "chain_named"; image: string }
  | { kind: "composed"; recipeSha256: string };

export function parseRebuildEnvironmentIdentity(persisted: string): RebuildEnvironmentIdentity {
  if (HEX_SHA256.test(persisted)) {
    return { kind: "composed", recipeSha256: persisted };
  }
  return { kind: "chain_named", image: persisted };
}
