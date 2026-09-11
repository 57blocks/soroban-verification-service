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
import { IsSourceCodeUriList } from "./validators/source-code-uri-list.js";
import { DtoValidationError } from "./validate.js";
import { ClosedTo } from "./validators/closed-to.js";
import { PresentOnlyWhen } from "./validators/present-only-when.js";
import { SupportedSchemaMajor } from "./validators/schema-version.js";

// Two classes per level, deliberately:

/**
 * Every 32-byte digest the status object carries — `wasm_hash`, `source_sha256`, `rebuilt_hash`, a
 * `results_urls` entry's `sha256` — in the one spelling it may be published in.
 */
export const SEP58_HEX_SHA256 = /^[0-9a-f]{64}$/;

/** SO5: one complete flag per entry, `=` form, order not significant. */
export const SEP58_BLDOPT_ENTRY = /^--[A-Za-z][A-Za-z0-9_-]*(=.+)?$/;

/** SEP-58 v0.6.0: `source_uri`'s scheme is open-ended, so this is not restricted to `https`. */
export const SOURCE_URI_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\S+|\/\S+)$/;

/** SEP-58 v0.6.0 and the SEP agree: an explicit registry host and a digest; a tag may precede the digest. */
export const BLDIMG_PATTERN = /^(?:localhost(?::\d+)?|[^\s@/]*[.:][^\s@/]*)\/[^\s@]+@sha256:[0-9a-f]{64}$/;

// SO1. Note the spelling: `mismatched`, not `mismatch` — our own `VerificationStatus` uses the latter and the
// two vocabularies must not be conflated.
export const registryVerificationStatuses = ["verified", "mismatched", "unverified"] as const;

export type RegistryVerificationStatus = (typeof registryVerificationStatuses)[number];

/** CV10's consumer rule: an unrecognised `status` reads as `unverified` rather than rejecting the document. */
export function registryStatusOrUnverified(value: unknown): RegistryVerificationStatus {
  return registryVerificationStatuses.includes(value as RegistryVerificationStatus)
    ? (value as RegistryVerificationStatus)
    : "unverified";
}

/** CV1 — the document-type discriminator every Results SEP document carries beside `schema_version`. */
export const REGISTRY_SCHEMA = "stellar-verification-status" as const;

/** The exact version our own published documents declare and are validated against — CV1. */
export const REGISTRY_SCHEMA_VERSION = "1.0";

/** The one MAJOR this code knows how to read. SO7's branch point. */
export const REGISTRY_SCHEMA_MAJOR = 1;

/** Replaces the draft's `out_of_band` boolean. */
export const RECIPE_SOURCES = ["on_chain_metadata", "submitted"] as const;
export type RecipeSource = (typeof RECIPE_SOURCES)[number];

export const IMAGE_TRUST_LEVELS = ["sdf_trusted", "upstream_pinned", "publicly_auditable", "arbitrary"] as const;
export type ImageTrustLevel = (typeof IMAGE_TRUST_LEVELS)[number];

/** No `signature`: nothing is signed, and a type nobody produces is a type other implementations copy. */
export const RESULT_URL_TYPES = ["report", "provenance", "attestation", "sbom", "audit"] as const;
export type ResultUrlType = (typeof RESULT_URL_TYPES)[number];

/**
 * Where a link's bytes actually live — independent of `type`'s content-category axis. Two `results_urls`
 * entries can both be `type: "report"` (this verifier's own copy and the Arweave copy) and distinguishable
 * only by inspecting the URL; `location` makes that structural.
 */
export const RESULT_URL_LOCATIONS = ["verifier_self_storage", "arweave"] as const;
export type ResultUrlLocation = (typeof RESULT_URL_LOCATIONS)[number];

// A logo is either a URL or light/dark variants. `oneOf` in the schema; both arms are accepted here and neither
// is required.
export class RegistryVerifierLogo {
  @IsOptional() @IsString() light?: string;
  @IsOptional() @IsString() dark?: string;
}

/** A verifier's identity, and there is only one thing in it that identifies: **`url`, the result root**. */
export class RegistryVerifier {
  @IsString() url!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional()
  @ValidateIf((_, value) => typeof value === "object")
  @ValidateNested()
  @Type(() => RegistryVerifierLogo)
  logo_url?: string | RegistryVerifierLogo;
}

/**
 * CONSUMER: a verifier block as a peer may still publish it. Both fields optional, because a document written
 * before `url` became the identity carries a name and nothing else.
 */
export class PeerRegistryVerifier {
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional()
  @ValidateIf((_, value) => typeof value === "object")
  @ValidateNested()
  @Type(() => RegistryVerifierLogo)
  logo_url?: string | RegistryVerifierLogo;
}

/**
 * `sha256` is optional in the wire type because a peer's `provenance`/`attestation` link may point at bytes it
 * does not control. `location` is optional for the same reason, widened: a peer's link may not classify into
 * `verifier_self_storage`/`arweave` at all, and we only assert it for entries we produce ourselves.
 */
export class RegistryResultUrl {
  @IsIn(RESULT_URL_TYPES) type!: ResultUrlType;
  @IsOptional() @IsIn(RESULT_URL_LOCATIONS) location?: ResultUrlLocation;
  @IsString() url!: string;
  @IsOptional() @Matches(SEP58_HEX_SHA256) sha256?: string;
}

/**
 * CONSUMER: a peer's link. **`type` and `location` are free strings here, and that is the point.** Both are
 * closed vocabularies for a producer and neither is closed for a reader: a `MINOR` may add a value — the SEP
 * names `ipfs` as a candidate — and CV2's forward-compatibility rule is `MAJOR`/`MINOR` tolerance *plus*
 * tolerating unrecognised enum values. Validating a peer's link against the producer's enums drops the whole
 * document over one word, which is the failure this split exists to prevent.
 */
export class PeerRegistryResultUrl {
  @IsString() @MinLength(1) type!: string;
  @IsOptional() @IsString() location?: string;
  @IsString() @MinLength(1) url!: string;
  @IsOptional() @Matches(SEP58_HEX_SHA256) sha256?: string;
}

/**
 * Where THIS verifier serves a retrievable copy of the source that produced the match. No `type`: every entry
 * is the same kind of thing (a source copy), so `location` alone distinguishes them — and, unlike
 * `RegistryResultUrl`, we always know it: we are the ones publishing every entry. No `sha256`: the entry's
 * parent already carries `source_sha256` over the same bytes, so a per-entry digest here would be redundant.
 */
export class RegistrySourceCodeUri {
  @IsIn(RESULT_URL_LOCATIONS) location!: ResultUrlLocation;
  @IsString() url!: string;
}

const hasVerdict = (entry: { status?: unknown }): boolean => entry.status !== "unverified";
const isUnverified = (entry: { status?: unknown }): boolean => entry.status === "unverified";
const isHex64 = (value: unknown): boolean => typeof value === "string" && SEP58_HEX_SHA256.test(value);
const isOneOf = (values: readonly string[]) => (value: unknown): boolean =>
  typeof value === "string" && values.includes(value);

/** The PRODUCER entry: what this verifier publishes. */
export class RegistryVerification {
  @ValidateNested() @Type(() => RegistryVerifier) verifier!: RegistryVerifier;

  /**
   * SO3 — an `unverified` entry is EXACTLY {verifier, status}, not merely one missing the four
   * verdict-conditional fields below: nothing has been published yet, so no recipe, no custody, no build
   * inputs and no links have a value. It rides on `status` because it is a rule about the whole entry, and
   * because a custom validator on `bldarg`/`results_urls` would break the OpenAPI derivation.
   */
  @ClosedTo(isUnverified, ["verifier", "status"], "status is unverified")
  @IsIn(registryVerificationStatuses) status!: RegistryVerificationStatus;

  @PresentOnlyWhen(hasVerdict, "status is verified or mismatched", isOneOf(RECIPE_SOURCES))
  recipe_source?: RecipeSource;

  @PresentOnlyWhen(hasVerdict, "status is verified or mismatched", isOneOf(IMAGE_TRUST_LEVELS))
  image_trust_level?: ImageTrustLevel;

  @IsOptional() @Matches(BLDIMG_PATTERN) bldimg?: string;

  // SEP-58 v0.6.0: order-significant, never sorted. Absent means `contract build`.
  @IsOptional() @IsArray() @IsString({ each: true }) bldarg?: string[];

  // SO5, via the shared `SEP58_BLDOPT_ENTRY` — see its comment for why it is not inline here.
  @IsOptional() @IsArray() @Matches(SEP58_BLDOPT_ENTRY, { each: true }) bldopt?: string[];

  @PresentOnlyWhen(hasVerdict, "status is verified or mismatched", isHex64)
  source_sha256?: string;

  @IsOptional() @Matches(SOURCE_URI_PATTERN) source_uri?: string;

  // SO2 — required when `mismatched`, and MUST be absent otherwise.
  @PresentOnlyWhen((entry: RegistryVerification) => entry.status === "mismatched", "status is mismatched", isHex64)
  rebuilt_hash?: string;

  // SO3.
  @PresentOnlyWhen(
    hasVerdict,
    "status is verified or mismatched",
    (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
  )
  processed_at?: string;

  // AU1 — structured entries; appended, never reset (see `appendArchiveReference`).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistryResultUrl)
  results_urls?: RegistryResultUrl[];

  // Where THIS verifier serves a retrievable copy of the source that produced the match — a per-verifier
  // capability SEP-58 has no opinion on.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistrySourceCodeUri)
  verified_source_code_uris?: RegistrySourceCodeUri[];
}

/** The CONSUMER entry: a peer's, or one of our own written under the Registry API draft. */
export class PeerRegistryVerification {
  @ValidateNested() @Type(() => PeerRegistryVerifier) verifier!: PeerRegistryVerifier;

  // Not `@IsIn`: CV10 coerces an unrecognised value to `unverified` on read instead of rejecting the document.
  @IsString() status!: string;

  /**
   * Free strings, like `status` and like a link's `type`: both are vocabularies a `MINOR` may extend, and a
   * reader that rejected an unrecognised value would drop the peer's whole document over one word (§7).
   * `RECIPE_SOURCES` and `IMAGE_TRUST_LEVELS` still bind the producer — see `RegistryVerification`.
   */
  @IsOptional() @IsString() recipe_source?: string;
  @IsOptional() @IsString() image_trust_level?: string;
  @IsOptional() @IsBoolean() out_of_band?: boolean;

  @IsOptional() @Matches(BLDIMG_PATTERN) bldimg?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) bldarg?: string[];
  @IsOptional() @IsArray() @Matches(SEP58_BLDOPT_ENTRY, { each: true }) bldopt?: string[];

  @IsOptional() @Matches(SEP58_HEX_SHA256) source_sha256?: string;
  @IsOptional() @Matches(SOURCE_URI_PATTERN) source_uri?: string;

  // SEP-58 v0.4.x — the draft's vocabulary. Read, never published.
  @IsOptional() @Matches(/^(https?:\/\/\S+|github:[^/\s]+\/[^/\s]+)$/) source_repo?: string;
  @IsOptional() @Matches(/^[0-9a-f]{40}$/) source_rev?: string;
  @IsOptional() @Matches(/^https?:\/\/\S+$/) tarball_url?: string;
  @IsOptional() @Matches(SEP58_HEX_SHA256) tarball_sha256?: string;

  @IsOptional() @Matches(SEP58_HEX_SHA256) rebuilt_hash?: string;
  @IsOptional() @IsString() processed_at?: string;

  /**
   * Structured entries only since 2026-09-10, where a bare URI string — the Registry API draft's shape —
   * was accepted before. **This field and not its neighbour**: `stellar-verification-aggregate` names
   * `results_urls` and types a relayed link as an object, so a string read here reaches a document it makes
   * non-conformant. Nothing downstream constrains `verified_source_code_uris`, so nothing is bought by
   * refusing a string there and a peer's whole document is the price.
   *
   * `PeerRegistryResultUrl` and not `RegistryResultUrl`: the *shape* is required, the *vocabulary* is not.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PeerRegistryResultUrl)
  results_urls?: PeerRegistryResultUrl[];

  @SchemaHint({
    type: "array",
    items: { oneOf: [{ type: "string", format: "uri" }, { $ref: "#/components/schemas/RegistrySourceCodeUri" }] },
    description: "A bare URI (pre-`location` shape) or a {location, url} entry.",
  })
  @IsOptional()
  @IsArray()
  @IsSourceCodeUriList()
  verified_source_code_uris?: (string | RegistrySourceCodeUri)[];
  // The singular spelling a peer on the draft may still emit (discussion #1945 never settled it) is
  // deliberately NOT declared: a malformed value must cost the peer that field, not its whole document
  // (CV6/CV8), which only an undeclared field gets.
}

/** A peer's singular `verified_source_code_uri`, when it sent one and it is a string. */
export function legacySingularSourceUri(entry: PeerRegistryVerification): string | undefined {
  const value = (entry as unknown as Record<string, unknown>).verified_source_code_uri;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Everything in the status object except `schema`/`schema_version`, which producer and consumer disagree about. */
abstract class RegistryStatusObjectFields {
  @Matches(SEP58_HEX_SHA256) wasm_hash!: string;

  // "When this record was last updated across all of its verifications" — moves when ANY entry changes,
  // including an archive-reference backfill; distinct from an entry's `processed_at`.
  @Matches(/^\d{4}-\d{2}-\d{2}T/, { message: "updated_at must be an RFC 3339 timestamp" })
  updated_at!: string;
}

/** The PRODUCER document: what we publish, and hold ourselves to on re-read. CV1's cited evidence. */
export class RegistryStatusObject extends RegistryStatusObjectFields {
  @Equals(REGISTRY_SCHEMA) schema!: typeof REGISTRY_SCHEMA;
  @Equals(REGISTRY_SCHEMA_VERSION) schema_version!: "1.0";

  /**
   * SO4 — at least one entry (`minItems: 1`). An empty array is not a way to say "nothing known": that is a
   * 404. And **at most one** (`maxItems: 1`, 2026-09-10): a result root publishes one result per Wasm hash,
   * its own, and cross-verifier results are a different document with a different `schema`. The array
   * survives because keying on identity rather than position is worth keeping; the bound is what stops a
   * writer from publishing something the SEP's own schema rejects. Only the producer is bounded — a peer's
   * document is whatever the peer wrote (CV6/CV8).
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegistryVerification)
  source_code_verifications!: RegistryVerification[];
}

/**
 * Strict parse of a document WE are about to publish: `additionalProperties: false` at every level, the way the
 * SEP schema states it.
 */
export function parseStrictRegistryStatusObject(value: unknown): RegistryStatusObject {
  // Through JSON first: a caller may hand in class instances from a tolerant parse, and class-transformer would
  // keep their prototypes instead of re-typing them as the producer classes below.
  const instance = plainToInstance(RegistryStatusObject, JSON.parse(JSON.stringify(value)));
  const errors = validateSync(instance as object, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) throw new DtoValidationError(errors);
  // A document, not a class instance: callers serialise it and compare it structurally.
  return JSON.parse(JSON.stringify(instance)) as RegistryStatusObject;
}

/** The CONSUMER document: what we accept from a peer, or read back from our own tree. */
export class PeerRegistryStatusObject extends RegistryStatusObjectFields {
  @IsOptional() @IsString() schema?: string;
  @SupportedSchemaMajor(REGISTRY_SCHEMA_MAJOR) schema_version!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PeerRegistryVerification)
  source_code_verifications!: PeerRegistryVerification[];
}

/**
 * Verifier identity for keying entries: the `url` when both carry one (AU2 — the result root's origin is what
 * attribution rests on), the `name` otherwise.
 */
export function isSameVerifier(a: PeerRegistryVerifier, b: PeerRegistryVerifier): boolean {
  if (a.url !== undefined && b.url !== undefined) return normalizeVerifierUrl(a.url) === normalizeVerifierUrl(b.url);
  // Only for a document written before `url` was required. `name` is self-claimed, so this is a best-effort
  // match on a legacy shape, never the rule.
  return a.name !== undefined && a.name === b.name;
}

/** How two result roots are compared for identity. */
export function normalizeVerifierUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    // Not a URL we can parse is compared as written: refusing here would drop a peer over a field we only use
    // for matching.
    return url.replace(/\/+$/, "");
  }
}

/** The `<sha256>` in a `…/reports/<sha256>.json` URL, if the URL has that shape. */
export function reportSha256FromUrl(url: string): string | undefined {
  const match = /\/reports\/([0-9a-f]{64})\.json(?:[?#].*)?$/.exec(url);
  return match?.[1];
}

/** Normalise a `results_urls` item read from either shape into the SEP's object form. */
export function toResultUrl(item: string | PeerRegistryResultUrl): PeerRegistryResultUrl {
  if (typeof item !== "string") return item;
  const sha256 = reportSha256FromUrl(item);
  return { type: "report", url: item, ...(sha256 ? { sha256 } : {}) };
}

/**
 * Normalise a `verified_source_code_uris` item read from either shape. A bare string is the only shape that
 * existed before `location` — always our own self-served `sources/` copy.
 */
export function toSourceCodeUri(item: string | RegistrySourceCodeUri): RegistrySourceCodeUri {
  if (typeof item !== "string") return item;
  return { location: "verifier_self_storage", url: item };
}

export type LegacyCustody = { imageTrustLevel?: ImageTrustLevel; verifierUrl?: string };

/**
 * Upgrade an entry written under the Registry API draft to the SEP producer shape, for a writer that is about
 * to rewrite the document it lives in.
 */
export function upgradeLegacyEntry(
  entry: PeerRegistryVerification,
  custody: LegacyCustody | undefined,
): RegistryVerification | undefined {
  const status = registryStatusOrUnverified(entry.status);
  const verdict = status !== "unverified";
  const imageTrustLevel = entry.image_trust_level ?? custody?.imageTrustLevel;
  // Everything `@PresentOnlyWhen(hasVerdict)` makes required on the producer shape.
  if (verdict && (!entry.source_sha256 || !imageTrustLevel || !entry.processed_at)) return undefined;
  if (status === "mismatched" && !entry.rebuilt_hash) return undefined;

  // The producer's custody vocabularies are closed sets; a peer's are not — the same asymmetry the link
  // guards below enforce. An entry carrying a value a later MINOR added cannot be carried into a document
  // we publish, so it is left alone rather than narrowed by force.
  const recipeSourceRaw = entry.recipe_source ?? (entry.out_of_band ? "submitted" : "on_chain_metadata");
  if (!(RECIPE_SOURCES as readonly string[]).includes(recipeSourceRaw)) return undefined;
  if (imageTrustLevel !== undefined && !(IMAGE_TRUST_LEVELS as readonly string[]).includes(imageTrustLevel)) {
    return undefined;
  }
  const recipeSource = recipeSourceRaw as RecipeSource;

  // `url` is the identity now, and the draft shape had no field for it — so every document we published before
  // the SEP shape carries a name and nothing else.
  const verifierUrl = entry.verifier.url ?? custody?.verifierUrl;
  if (verifierUrl === undefined) return undefined;

  // The producer's `type` is a closed set; a peer's is not.
  const resultsUrls = entry.results_urls?.map(toResultUrl);
  if (resultsUrls?.some((link) => !(RESULT_URL_TYPES as readonly string[]).includes(link.type))) return undefined;
  // A peer's `location` (on either field) is closed the same way once it upgrades to the producer shape.
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

  // The two guards above are what narrows a peer's open vocabulary to the producer's closed one; the compiler
  // cannot see it through `.some()`, so the cast stands in for them and must not outlive them.
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
    // SO3 closes an `unverified` producer entry to {verifier, status}: a peer may carry these under CV8, but
    // the moment we re-emit the entry as ours they have to go, or the strict parse below rejects our document.
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

/**
 * The base projection CV9 requires: the document with every field neither shape declares removed, so a consumer
 * insisting on strict closed-schema validation has something that passes.
 */
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
