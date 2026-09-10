import { createHash } from "node:crypto";
import { Type } from "class-transformer";
import {
  Equals,
  IsArray,
  IsDefined,
  IsIn,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator";
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

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeList(items: string[]): string {
  return `${items.length}:${items.join("")}`;
}

/** Not `JSON.stringify` — that is the K2/K4 bug class already fixed once for the idempotency key. */
export function composedEnvironmentRecipeHash(recipe: ComposedEnvironmentRecipe): string {
  const components = [...recipe.components].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );
  const encodedComponents = encodeList(
    components.map(
      (component) =>
        encodeField(component.kind) + encodeField(component.source) + encodeField(component.sha256),
    ),
  );
  const canonical =
    encodeField(recipe.schema) +
    encodeField(recipe.template_version) +
    encodeField(recipe.pair.cliver) +
    encodeField(recipe.pair.rsver) +
    encodedComponents;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
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
