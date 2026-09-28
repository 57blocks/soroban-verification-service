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
// Subpath imports only: core's barrel pulls in `node:crypto`, and the SDK imports this file to stay browser-bundleable.
import { PublishedBuildRecipe } from "@scvs/core/build-environment";
import { IMAGE_TRUST_LEVELS, type ImageTrustLevel } from "@scvs/core/registry";
import { ResultPointer, VerificationResultSummary } from "@scvs/core/result";
import { SupportedSchemaMajor } from "@scvs/core/validators/schema-version";

export const trustedVerifierStatuses = ["active", "paused", "disabled"] as const;

export type TrustedVerifierStatus = (typeof trustedVerifierStatuses)[number];

export class TrustedVerifier {
  /** Operator-local key; `url`, not this, identifies the verifier to anyone else. */
  @IsString() id!: string;
  @IsString() display_name!: string;
  /** The verifier's result root, and this entry's identity. */
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
  @IsUrl(
    { protocols: ["https"], require_protocol: true, require_tld: false },
    { message: "bulk_load_url must be an https: URL" },
  )
  bulk_load_url!: string;
}

export const TRUSTED_VERIFIERS_LIST_SCHEMA = "stellar-trusted-verifiers-list" as const;
export const TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY = "stellar-trusted-verifiers-list-v1" as const;
export const TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION = "1.0" as const;

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

/** Consumer side, standalone rather than `extends TrustedVerifier`: the producer class's property set feeds the OpenAPI schema. */
export class PeerTrustedVerifier {
  /** Optional: the SEP makes it implementation-local, so a conformant list may omit it. */
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() display_name?: string;
  @IsOptional() @IsString() url?: string;
  /** Pre-SEP spelling of `url`; read through `resultRootOf`, never directly. */
  @IsOptional() @IsString() cdn_root?: string;
  @IsOptional() @IsString() manifest_url?: string;
  @IsOptional() @IsString() trust_tier?: string;
  @IsIn(trustedVerifierStatuses)
  status!: TrustedVerifierStatus;
  @IsOptional() @IsString() bulk_load_url?: string;
}

export function resultRootOf(verifier: PeerTrustedVerifier): string | undefined {
  return verifier.url ?? verifier.cdn_root;
}

/** A peer entry whose result root has been resolved into an absolute `url`. */
export type ResolvedVerifier = Omit<PeerTrustedVerifier, "url" | "cdn_root"> & {
  url: string;
};

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
  @IsString() url!: string;
  @IsString() policy_url!: string;
  @IsString() updated_at!: string;
}

export class PeerVerifierManifest {
  @Equals("stellar-verifier-manifest-v1")
  schema!: "stellar-verifier-manifest-v1";
  @IsString() id!: string;
  @IsString() display_name!: string;
  /** Read the root through `manifestRootOf`: a lagging peer may send only `cdn_root`. */
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() cdn_root?: string;
  @IsString() policy_url!: string;
  @IsString() updated_at!: string;
}

export function manifestRootOf(manifest: PeerVerifierManifest): string | undefined {
  return manifest.url ?? manifest.cdn_root;
}

class BuildImagePolicy {
  @IsArray()
  @IsIn(IMAGE_TRUST_LEVELS, { each: true })
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

/** A read accept-list, wider than `SERVED_SOURCE_MODES`: one unknown mode fails discovery for every peer. */
export const SOURCE_MODES = ["public_repo", "hosted_tarball", "private_uploaded_tarball", "source_uri"] as const;

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

export class ArtifactProvenance {
  @IsIn(["on_chain_metadata", "submitted"]) recipe_source!: "on_chain_metadata" | "submitted";
  @IsIn(["network_isolated", "cli_managed"]) build_isolation!: "network_isolated" | "cli_managed";
}

export class ArtifactTrust {
  @IsBoolean() sep55_attestation_present!: boolean;
}

export class ArtifactSource {
  @IsString() source_sha256!: string;
  @IsBoolean() is_public!: boolean;
  // Present only when `is_public` is `true`.
  @IsOptional() @IsString() source_file_name?: string;
  @IsOptional() @IsString() source_uri?: string;
  // The `source_sha256` the deployed Wasm's `contractmetav0` records, when it records one.
  @IsOptional() @IsString() chain_source_sha256?: string;
}

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
  // Optional so reports published before these fields existed still validate.
  @IsOptional() @IsIn(IMAGE_TRUST_LEVELS) image_trust_level?: ImageTrustLevel;
  @IsOptional() @ValidateNested() @Type(() => PublishedBuildRecipe) build_recipe?: PublishedBuildRecipe;
}
