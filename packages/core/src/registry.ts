import { plainToInstance, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
  validateSync,
} from "class-validator";
import { SchemaHint } from "./schema-hint.js";
import { IsResultUrlList } from "./validators/result-url-list.js";
import { IsSourceCodeUriList } from "./validators/source-code-uri-list.js";
import { DtoValidationError } from "./validate.js";
import { ClosedTo } from "./validators/closed-to.js";
import { PresentOnlyWhen } from "./validators/present-only-when.js";
import { SupportedSchemaMajor } from "./validators/schema-version.js";
import { HEX_SHA256 } from "./digest.js";

export const SEP58_HEX_SHA256 = HEX_SHA256;

export const SEP58_BLDOPT_ENTRY = /^--[A-Za-z][A-Za-z0-9_-]*(=.+)?$/;

/** Any scheme, or an absolute path; not restricted to `https`. */
export const SOURCE_URI_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\S+|\/\S+)$/;

/** An explicit registry host, a repository (a tag may precede the digest) and a sha256 digest. */
export const BLDIMG_PATTERN = /^(?:localhost(?::\d+)?|[^\s@/]*[.:][^\s@/]*)\/[^\s@]+@sha256:[0-9a-f]{64}$/;

// `mismatched`, not the job vocabulary's `mismatch`.
export const registryVerificationStatuses = ["verified", "mismatched", "unverified"] as const;

export type RegistryVerificationStatus = (typeof registryVerificationStatuses)[number];

export function registryStatusOrUnverified(value: unknown): RegistryVerificationStatus {
  return registryVerificationStatuses.includes(value as RegistryVerificationStatus)
    ? (value as RegistryVerificationStatus)
    : "unverified";
}

export const REGISTRY_SCHEMA = "stellar-verification-status" as const;

export const REGISTRY_SCHEMA_VERSION = "1.0";

export const REGISTRY_SCHEMA_MAJOR = 1;

export const RECIPE_SOURCES = ["on_chain_metadata", "submitted"] as const;
export type RecipeSource = (typeof RECIPE_SOURCES)[number];

export const IMAGE_TRUST_LEVELS = ["official_trusted", "upstream_pinned", "publicly_auditable", "arbitrary"] as const;
export type ImageTrustLevel = (typeof IMAGE_TRUST_LEVELS)[number];

export const RESULT_URL_TYPES = ["report", "provenance", "attestation", "sbom", "audit"] as const;
export type ResultUrlType = (typeof RESULT_URL_TYPES)[number];

export const RESULT_URL_LOCATIONS = ["verifier_self_storage", "arweave"] as const;
export type ResultUrlLocation = (typeof RESULT_URL_LOCATIONS)[number];

export class RegistryVerifierLogo {
  @IsOptional() @IsString() light?: string;
  @IsOptional() @IsString() dark?: string;
}

export class RegistryVerifier {
  @IsString() url!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional()
  @ValidateIf((_, value) => typeof value === "object")
  @ValidateNested()
  @Type(() => RegistryVerifierLogo)
  logo_url?: string | RegistryVerifierLogo;
}

export class PeerRegistryVerifier {
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional()
  @ValidateIf((_, value) => typeof value === "object")
  @ValidateNested()
  @Type(() => RegistryVerifierLogo)
  logo_url?: string | RegistryVerifierLogo;
}

export class RegistryResultUrl {
  @IsIn(RESULT_URL_TYPES) type!: ResultUrlType;
  @IsOptional() @IsIn(RESULT_URL_LOCATIONS) location?: ResultUrlLocation;
  @IsString() url!: string;
  @IsOptional() @Matches(SEP58_HEX_SHA256) sha256?: string;
}

/** Consumer shape: `type`/`location` stay free strings so an unknown value cannot reject the whole document. */
export class PeerRegistryResultUrl {
  @IsString() @MinLength(1) type!: string;
  @IsOptional() @IsString() location?: string;
  @IsString() @MinLength(1) url!: string;
  @IsOptional() @Matches(SEP58_HEX_SHA256) sha256?: string;
}

export class RegistrySourceCodeUri {
  @IsIn(RESULT_URL_LOCATIONS) location!: ResultUrlLocation;
  @IsString() url!: string;
}

const hasVerdict = (entry: { status?: unknown }): boolean => entry.status !== "unverified";
const isUnverified = (entry: { status?: unknown }): boolean => entry.status === "unverified";
const isHex64 = (value: unknown): boolean => typeof value === "string" && SEP58_HEX_SHA256.test(value);
const isOneOf = (values: readonly string[]) => (value: unknown): boolean =>
  typeof value === "string" && values.includes(value);

export class RegistryVerification {
  @ValidateNested() @Type(() => RegistryVerifier) verifier!: RegistryVerifier;

  @ClosedTo(isUnverified, ["verifier", "status"], "status is unverified")
  @IsIn(registryVerificationStatuses) status!: RegistryVerificationStatus;

  @PresentOnlyWhen(hasVerdict, "status is verified or mismatched", isOneOf(RECIPE_SOURCES))
  recipe_source?: RecipeSource;

  @PresentOnlyWhen(hasVerdict, "status is verified or mismatched", isOneOf(IMAGE_TRUST_LEVELS))
  image_trust_level?: ImageTrustLevel;

  @IsOptional() @Matches(BLDIMG_PATTERN) bldimg?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) bldarg?: string[];

  @IsOptional() @IsArray() @Matches(SEP58_BLDOPT_ENTRY, { each: true }) bldopt?: string[];

  @PresentOnlyWhen(hasVerdict, "status is verified or mismatched", isHex64)
  source_sha256?: string;

  @IsOptional() @Matches(SOURCE_URI_PATTERN) source_uri?: string;

  @PresentOnlyWhen((entry: RegistryVerification) => entry.status === "mismatched", "status is mismatched", isHex64)
  rebuilt_hash?: string;

  @PresentOnlyWhen(
    hasVerdict,
    "status is verified or mismatched",
    (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
  )
  processed_at?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistryResultUrl)
  results_urls?: RegistryResultUrl[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistrySourceCodeUri)
  verified_source_code_uris?: RegistrySourceCodeUri[];
}

export class PeerRegistryVerification {
  @ValidateNested() @Type(() => PeerRegistryVerifier) verifier!: PeerRegistryVerifier;

  // Not `@IsIn`: an unknown status is coerced to `unverified` on read, never rejected.
  @IsString() status!: string;

  /** Free strings: a later MINOR may add values, which a reader must not reject. */
  @IsOptional() @IsString() recipe_source?: string;
  @IsOptional() @IsString() image_trust_level?: string;
  @IsOptional() @IsBoolean() out_of_band?: boolean;

  @IsOptional() @Matches(BLDIMG_PATTERN) bldimg?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) bldarg?: string[];
  @IsOptional() @IsArray() @Matches(SEP58_BLDOPT_ENTRY, { each: true }) bldopt?: string[];

  @IsOptional() @Matches(SEP58_HEX_SHA256) source_sha256?: string;
  @IsOptional() @Matches(SOURCE_URI_PATTERN) source_uri?: string;

  @IsOptional() @Matches(/^(https?:\/\/\S+|github:[^/\s]+\/[^/\s]+)$/) source_repo?: string;
  @IsOptional() @Matches(/^[0-9a-f]{40}$/) source_rev?: string;
  @IsOptional() @Matches(/^https?:\/\/\S+$/) tarball_url?: string;
  @IsOptional() @Matches(SEP58_HEX_SHA256) tarball_sha256?: string;

  @IsOptional() @Matches(SEP58_HEX_SHA256) rebuilt_hash?: string;
  @IsOptional() @IsString() processed_at?: string;

  /** Bare strings stay accepted (our own older documents carry them); `toResultUrl` normalises them. */
  // Inlined, not `$ref`-ed: `PeerRegistryResultUrl` is not among the emitted schemas.
  @SchemaHint({
    type: "array",
    items: {
      oneOf: [
        { type: "string", format: "uri" },
        {
          type: "object",
          required: ["type", "url"],
          properties: {
            type: { type: "string" },
            url: { type: "string" },
            location: { type: "string" },
            sha256: { type: "string", pattern: SEP58_HEX_SHA256.source },
          },
        },
      ],
    },
    description: "A bare URI (pre-SEP draft shape) or a {type, url, location?, sha256?} entry.",
  })
  @IsOptional()
  @IsArray()
  @IsResultUrlList()
  results_urls?: (string | PeerRegistryResultUrl)[];

  @SchemaHint({
    type: "array",
    items: { oneOf: [{ type: "string", format: "uri" }, { $ref: "#/components/schemas/RegistrySourceCodeUri" }] },
    description: "A bare URI (pre-`location` shape) or a {location, url} entry.",
  })
  @IsOptional()
  @IsArray()
  @IsSourceCodeUriList()
  verified_source_code_uris?: (string | RegistrySourceCodeUri)[];
  // `verified_source_code_uri` stays undeclared so a malformed value cannot reject the document.
}

export function legacySingularSourceUri(entry: PeerRegistryVerification): string | undefined {
  const value = (entry as unknown as Record<string, unknown>).verified_source_code_uri;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

abstract class RegistryStatusObjectFields {
  @Matches(SEP58_HEX_SHA256) wasm_hash!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}T/, { message: "updated_at must be an RFC 3339 timestamp" })
  updated_at!: string;
}

export class RegistryStatusObject extends RegistryStatusObjectFields {
  @Equals(REGISTRY_SCHEMA) schema!: typeof REGISTRY_SCHEMA;
  @Equals(REGISTRY_SCHEMA_VERSION) schema_version!: "1.0";

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegistryVerification)
  source_code_verifications!: RegistryVerification[];
}

export function parseStrictRegistryStatusObject(value: unknown): RegistryStatusObject {
  // Through JSON first: class-transformer would otherwise keep the prototypes of instances passed in.
  const instance = plainToInstance(RegistryStatusObject, JSON.parse(JSON.stringify(value)));
  const errors = validateSync(instance as object, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) throw new DtoValidationError(errors);
  return JSON.parse(JSON.stringify(instance)) as RegistryStatusObject;
}

export class PeerRegistryStatusObject extends RegistryStatusObjectFields {
  @IsOptional() @IsString() schema?: string;
  @SupportedSchemaMajor(REGISTRY_SCHEMA_MAJOR) schema_version!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PeerRegistryVerification)
  source_code_verifications!: PeerRegistryVerification[];
}

export function isSameVerifier(a: PeerRegistryVerifier, b: PeerRegistryVerifier): boolean {
  if (a.url !== undefined && b.url !== undefined) return normalizeVerifierUrl(a.url) === normalizeVerifierUrl(b.url);
  return a.name !== undefined && a.name === b.name;
}

export function normalizeVerifierUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** A result root's own entry. The first entry stands in only when no entry names a `verifier.url`. */
export function ownEntryOf<T extends PeerRegistryVerification>(entries: readonly T[], resultRoot: string): T | undefined {
  const root = normalizeVerifierUrl(resultRoot);
  const matched = entries.find(
    (entry) => entry.verifier?.url !== undefined && normalizeVerifierUrl(entry.verifier.url) === root,
  );
  if (matched) return matched;
  return entries.some((entry) => entry.verifier?.url !== undefined) ? undefined : entries[0];
}

export function reportSha256FromUrl(url: string): string | undefined {
  const match = /\/reports\/([0-9a-f]{64})\.json(?:[?#].*)?$/.exec(url);
  return match?.[1];
}

export function toResultUrl(item: string | PeerRegistryResultUrl): PeerRegistryResultUrl {
  if (typeof item !== "string") return item;
  const sha256 = reportSha256FromUrl(item);
  return { type: "report", url: item, ...(sha256 ? { sha256 } : {}) };
}

export function toSourceCodeUri(item: string | RegistrySourceCodeUri): RegistrySourceCodeUri {
  if (typeof item !== "string") return item;
  return { location: "verifier_self_storage", url: item };
}

export type LegacyCustody = { imageTrustLevel?: ImageTrustLevel; verifierUrl?: string };

export function upgradeLegacyEntry(
  entry: PeerRegistryVerification,
  custody: LegacyCustody | undefined,
): RegistryVerification | undefined {
  const status = registryStatusOrUnverified(entry.status);
  const verdict = status !== "unverified";
  const imageTrustLevel = entry.image_trust_level ?? custody?.imageTrustLevel;
  if (verdict && (!entry.source_sha256 || !imageTrustLevel || !entry.processed_at)) return undefined;
  if (status === "mismatched" && !entry.rebuilt_hash) return undefined;

  const recipeSourceRaw = entry.recipe_source ?? (entry.out_of_band ? "submitted" : "on_chain_metadata");
  if (!(RECIPE_SOURCES as readonly string[]).includes(recipeSourceRaw)) return undefined;
  if (imageTrustLevel !== undefined && !(IMAGE_TRUST_LEVELS as readonly string[]).includes(imageTrustLevel)) {
    return undefined;
  }
  const recipeSource = recipeSourceRaw as RecipeSource;

  const verifierUrl = entry.verifier.url ?? custody?.verifierUrl;
  if (verifierUrl === undefined) return undefined;

  const resultsUrls = entry.results_urls?.map(toResultUrl);
  if (resultsUrls?.some((link) => !(RESULT_URL_TYPES as readonly string[]).includes(link.type))) return undefined;
  if (
    resultsUrls?.some(
      (link) => link.location !== undefined && !(RESULT_URL_LOCATIONS as readonly string[]).includes(link.location),
    )
  ) {
    return undefined;
  }

  const sourceCodeUris = entry.verified_source_code_uris?.map(toSourceCodeUri);
  if (sourceCodeUris?.some((uri) => !(RESULT_URL_LOCATIONS as readonly string[]).includes(uri.location))) {
    return undefined;
  }

  // Safe only because of the two guards above.
  const producerLinks = resultsUrls as RegistryResultUrl[] | undefined;

  const upgraded: RegistryVerification = {
    verifier: { url: verifierUrl, ...(entry.verifier.name !== undefined ? { name: entry.verifier.name } : {}) },
    status,
    ...(verdict
      ? {
          recipe_source: recipeSource,
          image_trust_level: imageTrustLevel as ImageTrustLevel,
          source_sha256: entry.source_sha256,
          processed_at: entry.processed_at,
        }
      : {}),
    // Dropped on `unverified`: the strict producer parse rejects them there.
    ...(verdict && entry.bldimg ? { bldimg: entry.bldimg } : {}),
    ...(verdict && entry.bldarg ? { bldarg: entry.bldarg } : {}),
    ...(verdict && entry.bldopt ? { bldopt: entry.bldopt } : {}),
    ...(verdict && entry.source_uri ? { source_uri: entry.source_uri } : {}),
    ...(status === "mismatched" && entry.rebuilt_hash ? { rebuilt_hash: entry.rebuilt_hash } : {}),
    ...(verdict && producerLinks ? { results_urls: producerLinks } : {}),
    ...(verdict
      ? sourceCodeUris
        ? { verified_source_code_uris: sourceCodeUris }
        : legacySingularSourceUri(entry)
          ? { verified_source_code_uris: [toSourceCodeUri(legacySingularSourceUri(entry)!)] }
          : {}
      : {}),
  };
  return upgraded;
}

// An extension identifier is `<namespace>.<name>/<MAJOR.MINOR>`.
export const EXTENSION_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\/\d+\.\d+$/;

export function baseProjection(document: Record<string, unknown>): Record<string, unknown> {
  const documentKeys = ["schema", "schema_version", "wasm_hash", "updated_at", "source_code_verifications"];
  const entryKeys = [
    "verifier",
    "status",
    "recipe_source",
    "image_trust_level",
    "out_of_band",
    "bldimg",
    "bldarg",
    "bldopt",
    "source_repo",
    "source_rev",
    "tarball_url",
    "tarball_sha256",
    "source_sha256",
    "source_uri",
    "verified_source_code_uris",
    "rebuilt_hash",
    "processed_at",
    "results_urls",
  ];
  const pick = (source: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));

  const projected = pick(document, documentKeys);
  const entries = document.source_code_verifications;
  if (Array.isArray(entries)) {
    projected.source_code_verifications = entries.map((entry) =>
      pick(entry as Record<string, unknown>, entryKeys),
    );
  }
  return projected;
}
