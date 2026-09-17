import { Type } from "class-transformer";
import {
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from "class-validator";
// Subpath imports, not `@scvs/core`'s barrel: the barrel re-exports `rebuild-key.js` (`node:crypto`), and
// `clients/sdk` imports this file's `./shapes` subpath to stay browser-bundleable.
import { PublishedBuildRecipe } from "@scvs/core/build-environment";
import { IMAGE_TRUST_LEVELS, type ImageTrustLevel } from "@scvs/core/registry";
import { ResultPointer, VerificationResultSummary } from "@scvs/core/result";
import { SupportedSchemaMajor } from "@scvs/core/validators/schema-version";

// The published result tree's own shapes — the S3/CDN wire format this package reads and writes.

/**
 * The three states a Trusted Verifiers List member can be in. A second copy of these three strings is how
 * `paused` would go missing again.
 */
export const trustedVerifierStatuses = ["active", "paused", "disabled"] as const;

export type TrustedVerifierStatus = (typeof trustedVerifierStatuses)[number];

// One entry in the Trusted Verifiers List (config/trusted-verifiers.local.json, packages/db
// trusted-verifiers.repo.ts).
export class TrustedVerifier {
  /**
   * Local to this operator. The table is keyed by it and the sync uses it, and it is **not** what identifies a
   * verifier to anyone else — `url` is.
   */
  @IsString() id!: string;
  /** The operator's own label, for its own display. Not identity, and not the verifier's own name. */
  @IsString() display_name!: string;
  /**
   * The verifier's result root, and this entry's identity. Every TVL entry URL becomes an outbound fetch
   * origin (`originsFromVerifiers`), so its scheme is constrained the same way `SCVS_TRUSTED_VERIFIERS_SOURCE`
   * already is: `checkUrl`'s private-range and DNS-rebinding checks only run at request time, but a
   * non-`https:` scheme here is wrong regardless of what a name resolves to, so it is caught here instead of
   * waiting for the first fetch to refuse it. `require_tld: false` matches `checkUrl`'s own tolerance for an
   * IP-literal or bare hostname (e.g. a self-hosted deployment's internal DNS) — `checkUrl`, not this field,
   * is what refuses a private range.
   */
  @IsUrl(
    { protocols: ["https"], require_protocol: true, require_tld: false },
    { message: "url must be an https: URL" },
  )
  url!: string;
  @IsUrl(
    { protocols: ["https"], require_protocol: true, require_tld: false },
    { message: "manifest_url must be an https: URL" },
  )
  manifest_url!: string;
  @IsOptional()
  @IsString()
  trust_tier?: string;
  @IsIn(trustedVerifierStatuses)
  status!: TrustedVerifierStatus;
  /** Where this verifier serves its own bulk load. */
  @IsUrl(
    { protocols: ["https"], require_protocol: true, require_tld: false },
    { message: "bulk_load_url must be an https: URL" },
  )
  bulk_load_url!: string;
}

export const TRUSTED_VERIFIERS_LIST_SCHEMA = "stellar-trusted-verifiers-list" as const;
export const TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY = "stellar-trusted-verifiers-list-v1" as const;
export const TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION = "1.0" as const;

/** PRODUCER: what `GET /v1/verifiers` answers. The consumer side is `PeerTrustedVerifiersList`. */
export class TrustedVerifiersList {
  @Equals(TRUSTED_VERIFIERS_LIST_SCHEMA)
  schema!: typeof TRUSTED_VERIFIERS_LIST_SCHEMA;
  @Equals(TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION)
  schema_version!: "1.0";
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrustedVerifier)
  verifiers!: TrustedVerifier[];
  @IsString() updated_at!: string;
}

/**
 * CONSUMER: one entry of a list handed to us.
 *
 * Standalone, and deliberately not `extends TrustedVerifier`: `TrustedVerifiersList` is the declared type of
 * `GET /v1/verifiers` (`@ApiOkResponse` in query-svc's verifiers controller), so the producer class feeds the
 * `class-validator-jsonschema` derivation and its property set has to stay exactly what we serve. Re-declaring
 * a field with `declare` relaxes only the runtime validator — the TS type stayed `string` — which is how
 * `url` and `bulk_load_url` came to lie about themselves. Spelling the consumer's own optionality out costs
 * four duplicated fields and buys a type that matches what a peer may actually hand us.
 */
export class PeerTrustedVerifier {
  /**
   * OPTIONAL, matching the published schema (`verifier_entry.required` is `["url", "status"]` and nothing
   * more). The SEP says this field is implementation-local — it means nothing outside the aggregator that
   * minted it — so a list author is entitled to omit it, and a consumer that demanded one would reject a
   * conformant list. `url` is the identity; anything here that needs a label falls back to it.
   */
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() display_name?: string;
  /** The result root, under this SEP's spelling. A pre-SEP list may spell it `cdn_root` instead. */
  @IsOptional() @IsString() url?: string;
  /** The pre-SEP spelling of `url`. Read through `resultRootOf`, never directly. */
  @IsOptional() @IsString() cdn_root?: string;
  /**
   * OPTIONAL. Nothing the Results SEP specifies is read out of the document behind it — every SEP field is
   * served from the result root — so its absence is a conformance class and not a defect, and it is
   * `discover()`'s `not_advertised` arm rather than an error. `discover()` itself is an extension beyond the
   * SEP: it expects our own `stellar-verifier-manifest-v1` shape and follows that document's `policy_url`.
   */
  @IsOptional() @IsString() manifest_url?: string;
  @IsOptional() @IsString() trust_tier?: string;
  @IsIn(trustedVerifierStatuses)
  status!: TrustedVerifierStatus;
  @IsOptional() @IsString() bulk_load_url?: string;
}

/** The result root from either spelling, or undefined when the entry declares neither. */
export function resultRootOf(verifier: PeerTrustedVerifier): string | undefined {
  return verifier.url ?? verifier.cdn_root;
}

/**
 * A peer entry after the consumer has resolved its result root: `url` is present and absolute, and the
 * pre-SEP `cdn_root` spelling is gone. Everything else keeps the peer's optionality — notably `manifest_url`,
 * which resolution cannot invent.
 */
export type ResolvedVerifier = Omit<PeerTrustedVerifier, "url" | "cdn_root"> & {
  url: string;
};

/** CONSUMER: a list handed to us — by `clients/sdk`'s caller, or by our own seeded configuration. */
export class PeerTrustedVerifiersList {
  @IsIn([TRUSTED_VERIFIERS_LIST_SCHEMA, TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY])
  schema!: string;
  @IsOptional() @SupportedSchemaMajor(1) schema_version?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PeerTrustedVerifier)
  verifiers!: PeerTrustedVerifier[];
  @IsString() updated_at!: string;
}

export class VerifierManifest {
  @Equals("stellar-verifier-manifest-v1")
  schema!: "stellar-verifier-manifest-v1";
  @IsString() id!: string;
  @IsString() display_name!: string;
  /** This verifier's own result root. */
  @IsString() url!: string;
  @IsString() policy_url!: string;
  @IsString() updated_at!: string;
}

/**
 * CONSUMER: a manifest published by whoever a Trusted Verifiers List points at. A TVL entry moves
 * when its operator edits a file; a manifest moves when the verifier publishing it is **redeployed**,
 * so `cdn_root` outlives its rename for as long as any peer's rollout lags.
 */
export class PeerVerifierManifest {
  @Equals("stellar-verifier-manifest-v1")
  schema!: "stellar-verifier-manifest-v1";
  @IsString() id!: string;
  @IsString() display_name!: string;
  /**
   * Standalone rather than `extends VerifierManifest`, for the reason `PeerTrustedVerifier` is: `declare url:
   * string` relaxed the validator and left the TYPE promising a string, so an SDK consumer reading
   * `manifest.url` off a lagging peer got `undefined` from a field TypeScript said was always there. Read the
   * root through `manifestRootOf`, never off one spelling.
   */
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() cdn_root?: string;
  /** Required: `discover()` cannot report a policy it has no URL for, and a manifest without one is broken. */
  @IsString() policy_url!: string;
  @IsString() updated_at!: string;
}

/** A manifest's own result root from either spelling, or undefined when it declares neither. */
export function manifestRootOf(manifest: PeerVerifierManifest): string | undefined {
  return manifest.url ?? manifest.cdn_root;
}

class BuildImagePolicy {
  @IsArray()
  // The one list, from `@scvs/core/registry`: a second copy of these strings is how `upstream_pinned` went
  // missing here while the status object accepted it.
  @IsIn(IMAGE_TRUST_LEVELS, { each: true })
  // `string[]`, not `ImageTrustLevel[]`: the value arrives from an env CSV (`SCVS_POLICY_ACCEPTED_TRUST_LEVELS`
  // via `@scvs/config`), so `@IsIn` is what narrows it, at the only moment the narrowing can be checked.
  accepted_trust_levels!: string[];
  @IsBoolean() digest_pinned_only!: boolean;
  @IsBoolean() tag_only_allowed!: boolean;
  @IsBoolean() arbitrary_user_images_allowed!: boolean;
}

class PrivateSourcePolicy {
  @IsBoolean() requires_tarball_sha256_match!: boolean;
  @IsBoolean() publish_source_bytes!: boolean;
}

class RetentionPolicy {
  @IsBoolean() source_retained_after_verification!: boolean;
  @IsBoolean() result_artifacts_retained!: boolean;
}

/**
 * The wire vocabulary, which is wider than what this verifier serves (`SERVED_SOURCE_MODES`) because it is a
 * *read* accept-list first: `clients/sdk`'s `discover()` parses every peer's `policy.json` through this class
 * inside a `Promise.all`, so an unknown mode fails discovery for all of them, and a peer verifying from a
 * public git repository is entitled to say so.
 */
export const SOURCE_MODES = ["public_repo", "hosted_tarball", "private_uploaded_tarball", "source_uri"] as const;

// A verifier's trust policy (config/verifier-policy.json).
export class VerifierPolicy {
  @Equals("stellar-verifier-policy-v1") schema!: "stellar-verifier-policy-v1";
  @IsString() id!: string;
  @ValidateNested()
  @Type(() => BuildImagePolicy)
  build_images!: BuildImagePolicy;
  @IsArray()
  @IsIn(SOURCE_MODES, { each: true })
  source_modes!: string[];
  @ValidateNested()
  @Type(() => PrivateSourcePolicy)
  private_source!: PrivateSourcePolicy;
  @ValidateNested() @Type(() => RetentionPolicy) retention!: RetentionPolicy;
}

class VerificationArtifactVerifier {
  @IsString() id!: string;
  @IsString() policy_id!: string;
}

// RA3: the chain-of-custody signal — where the build recipe came from.
export class ArtifactProvenance {
  @IsIn(["on_chain_metadata", "submitted"]) recipe_source!: "on_chain_metadata" | "submitted";
  // RA4: which isolation regime produced this result.
  @IsIn(["network_isolated", "cli_managed"]) build_isolation!: "network_isolated" | "cli_managed";
}

// RA5: exactly one boolean, set from exactly one observation with no network call.
export class ArtifactTrust {
  @IsBoolean() sep55_attestation_present!: boolean;
}

// `unavailable` is read-and-aggregate's concern, observed at read time against a live static fetch under the
// result root, never written here.
export class ArtifactSource {
  @IsString() source_sha256!: string;
  @IsBoolean() is_public!: boolean;
  // Present only when `is_public` is `true`; absent for `is_public: false` since nothing is ever published.
  @IsOptional() @IsString() source_file_name?: string;
  // `source_file_name` names the stored copy.
  @IsOptional() @IsString() source_uri?: string;
  // The `source_sha256` the deployed Wasm's `contractmetav0` records, when it records one — read once at
  // rebuild creation and immutable for a given Wasm, so RA2-safe like every field above.
  @IsOptional() @IsString() chain_source_sha256?: string;
}

// reports/{report_sha256}.json — the full published report artifact, written by
// services/orchestrator-svc/src/modules/publish and read via packages/storage-layout.
export class VerificationArtifact {
  @Equals("stellar-verification-artifact-v1")
  schema!: "stellar-verification-artifact-v1";
  @ValidateNested()
  @Type(() => VerificationArtifactVerifier)
  verifier!: VerificationArtifactVerifier;
  @ValidateNested()
  @Type(() => ArtifactProvenance)
  provenance!: ArtifactProvenance;
  @ValidateNested()
  @Type(() => ArtifactTrust)
  trust!: ArtifactTrust;
  @ValidateNested()
  @Type(() => ArtifactSource)
  source!: ArtifactSource;
  @ValidateNested()
  @Type(() => VerificationResultSummary)
  result!: VerificationResultSummary;
  // Both fields kept `@IsOptional()` so a report published before either existed still reads back as a valid
  // artifact — see `readLegacyCustody` for the fallback that covers it.
  @IsOptional() @IsIn(IMAGE_TRUST_LEVELS) image_trust_level?: ImageTrustLevel;
  @IsOptional() @ValidateNested() @Type(() => PublishedBuildRecipe) build_recipe?: PublishedBuildRecipe;
}

// wasms/{wasm_hash}.json — the Registry API's per-wasm status object.
