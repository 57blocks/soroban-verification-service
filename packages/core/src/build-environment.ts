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
// The chain-derived toolchain identity for a cli-legacy contract, and the recipe a *composed* environment is
// built from.

/** The `(cliver, rsver)` pair a cli-legacy Wasm's `contractmetav0` section records. */
export class RecordedToolchainPair {
  @IsString() cliver!: string;
  @IsString() rsver!: string;
}

/**
 * One pinned input to a composed environment. Populating instances with real values is materialization, not
 * resolution; this file only defines the shape.
 */
export class OfficialComponent {
  @IsIn(["rust_toolchain", "stellar_cli", "base_image", "runtime_library"]) kind!:
    | "rust_toolchain"
    | "stellar_cli"
    | "base_image"
    | "runtime_library";
  @IsString() source!: string;
  @Matches(/^sha256:[0-9a-f]{64}$/) sha256!: string;
}

/** `template_version` identifies which template version produced it. */
export class ComposedEnvironmentRecipe {
  @Equals("scvs-composed-environment-v1") schema!: "scvs-composed-environment-v1";
  // `@IsDefined()`/`@IsArray()` alongside `@ValidateNested()`: nested validators check *contents* and pass
  // silently on an absent value, so without them a recipe missing its pair or components would validate clean.
  @IsDefined() @ValidateNested() @Type(() => RecordedToolchainPair) pair!: RecordedToolchainPair;
  @IsString() template_version!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OfficialComponent)
  components!: OfficialComponent[];
}

/**
 * The shape `VerificationArtifact.build_recipe` (packages/storage-layout/src/shapes.ts) actually promises, so a
 * regression that drops a component's `sha256` or a composed recipe's checksum fails to publish instead of
 * passing through the artifact's own `@IsObject()` catch-all silently. `kind === "composed"` is the only case
 * `recipe_sha256`/`recipe` apply to — a chain-named build has neither, so `@ValidateIf` keeps them absent there
 * rather than merely optional everywhere.
 */
export class BuildEnvironmentRecord {
  @IsIn(["chain_named", "composed"]) kind!: "chain_named" | "composed";
  @IsIn(IMAGE_TRUST_LEVELS) trust_level!: ImageTrustLevel;
  @IsString() image_reference!: string;

  @ValidateIf((o: BuildEnvironmentRecord) => o.kind === "composed")
  @Matches(/^[0-9a-f]{64}$/)
  recipe_sha256?: string;

  @ValidateIf((o: BuildEnvironmentRecord) => o.kind === "composed")
  @Matches(/^sha256:[0-9a-f]{64}$/)
  image_digest?: string;

  @ValidateIf((o: BuildEnvironmentRecord) => o.kind === "composed")
  @IsDefined()
  @ValidateNested()
  @Type(() => ComposedEnvironmentRecipe)
  recipe?: ComposedEnvironmentRecipe;
}

/**
 * `build_options` stays a passthrough bag (it is CLI flags, not custody evidence, and
 * RegistryVerification.bldopt already shape-checks the parts of it that matter).
 *
 * Named `Published*`, not `BuildRecipe`: `source.ts` already has a `BuildRecipe` (the CLI recipe a *submitter*
 * hands over) — an unrelated concept that happens to share the name.
 */
export class PublishedBuildRecipe {
  @IsString() build_image!: string;
  @ValidateNested() @Type(() => BuildEnvironmentRecord) build_environment!: BuildEnvironmentRecord;
  @IsOptional() @IsObject() build_options?: Record<string, unknown>;
}

/**
 * What resolution decides for an addressable pair with no chain-named image: *which* recipe should be composed,
 * not the recipe itself.
 */
export class ComposeIntent {
  @IsDefined() @ValidateNested() @Type(() => RecordedToolchainPair) pair!: RecordedToolchainPair;
  @IsString() template_version!: string;
}

/** The single verifier-owned composition template this verifier currently uses. */
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

/**
 * Deliberately narrow: it does **not** classify `cliver` values naming a commit between releases
 * (`unreleased_cli`), which needs the released `stellar-cli` tag set and belongs to the resolver.
 */
export function isUndatedNightlyRsver(rsver: string): boolean {
  return UNDATED_NIGHTLY_RE.test(rsver);
}

/** The chain_named/compose/unsupported decision. */
export function classifyBuildEnvironment(input: {
  /** Only ever set once the caller's own `evaluateBuildImage()` has already accepted it. */
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

  // `unreleased_cli` is never reached here — see `isUndatedNightlyRsver()`'s own comment for why this function
  // has no data source to classify it and must not guess.
  return {
    kind: "compose",
    intent: { pair: input.pair, template_version: CURRENT_COMPOSE_TEMPLATE_VERSION },
    trustLevel: "upstream_pinned",
  };
}

/**
 * A `Rebuild` keys on it for cli-legacy, and a `imageDigest` is only where *our* copy lives — an operational
 * pull coordinate that may differ across
 */
/** The two host architectures this verifier runs Batch compute environments for. */
export const buildArchitectures = ["arm64", "amd64"] as const;

export type BuildArchitecture = (typeof buildArchitectures)[number];

/**
 * Narrows an arbitrary reported architecture to one we have a Batch queue for, so every consumer treats
 * "something else" the same way: **absent**, never an error and never passed through.
 */
export function isBuildArchitecture(value: unknown): value is BuildArchitecture {
  return typeof value === "string" && (buildArchitectures as readonly string[]).includes(value);
}

export type MaterializedEnvironment = {
  recipeSha256: string;
  imageDigest: string;
  recipe: ComposedEnvironmentRecipe;
  /**
   * Which architecture our stored image was built for, when the composer reported it — what lets dispatch route
   * to a queue whose hosts can run it **without** asking a registry it cannot read.
   */
  arch?: BuildArchitecture;
};

/** What one call to `BuildEnvironmentMaterializer.materialize()` can honestly report. */
export type MaterializationResult =
  | { kind: "ready"; environmentId: string; environment: MaterializedEnvironment }
  | { kind: "composing"; environmentId: string }
  | { kind: "failed"; environmentId: string; errorCode: string };

/** What a `Rebuild`'s persisted environment identity turns out to be. See the parser below. */
export type RebuildEnvironmentIdentity =
  | { kind: "chain_named"; image: string }
  | { kind: "composed"; recipeSha256: string };

const BARE_SHA256_RE = /^[0-9a-f]{64}$/;

/** Reads `Rebuild.imageDigest` back as what it actually is. One column, two kinds of value. */
export function parseRebuildEnvironmentIdentity(persisted: string): RebuildEnvironmentIdentity {
  if (BARE_SHA256_RE.test(persisted)) {
    return { kind: "composed", recipeSha256: persisted };
  }
  return { kind: "chain_named", image: persisted };
}
