import { Type } from "class-transformer";
import { Equals, IsArray, IsIn, IsOptional, IsString, ValidateNested } from "class-validator";
import { PeerRegistryVerification, registryStatusOrUnverified, RegistryVerifier } from "./registry.js";
import { SupportedSchemaMajor } from "./validators/schema-version.js";

// They live in the kernel rather than in query-svc because query-svc depends on clients/sdk, which produces the
// same shapes — owning them in the service would invert that edge into a cycle.

/** A verifier that could not contribute to this view. */
export class UnavailableVerifier {
  @IsString() url!: string;
  @IsOptional() @IsString() name?: string;
  /** `refused` means the policy rejected the destination before any request was made. */
  @IsIn(["fetch_failed", "invalid_response", "timeout", "refused"])
  reason!: "fetch_failed" | "invalid_response" | "timeout" | "refused";
  @IsOptional() @IsString() error?: string;
}

/**
 * Descriptive, never a verdict. `single` exists because "unanimous" among one verifier overstates, and one
 * entry is the common case: most hashes have been seen by one verifier.
 */
export const agreementSummaries = [
  "single",
  "unanimous_verified",
  "unanimous_mismatched",
  "disputed",
  "unverified_only",
  "no_data",
] as const;

export type AgreementSummary = (typeof agreementSummaries)[number];

/**
 * One verifier's entry, relayed. Extends the CONSUMER entry class: an aggregate relays what peers published, in
 * whichever of the two shapes (draft or SEP) they published it.
 */
export class AggregatedRegistryVerification extends PeerRegistryVerification {
  /** Narrower than the consumer class it extends: `url` is REQUIRED here. */
  @ValidateNested() @Type(() => RegistryVerifier) declare verifier: RegistryVerifier;

  @IsOptional() @IsString() schema_version?: string;

  /** Present only when this entry came from the retained copy rather than a live read (AB5). */
  @IsOptional() @IsString() retrieved_at?: string;
}

/** Never a published file — the mapping it rests on is re-read every time. */
export const AGGREGATE_SCHEMA = "stellar-verification-aggregate" as const;

/**
 * Ours, not any peer's: the version of the aggregate **we** emit. It does not move because a contributing
 * peer declared a higher MINOR. A constant because it was spelled as a literal in both writers and in the
 * validator below — three copies of one number, which is how `schema_version` drifted the last time.
 */
export const AGGREGATE_SCHEMA_VERSION = "1.0" as const;

export class AggregatedWasmStatus {
  @Equals(AGGREGATE_SCHEMA) schema!: typeof AGGREGATE_SCHEMA;
  @IsIn([AGGREGATE_SCHEMA_VERSION]) schema_version!: typeof AGGREGATE_SCHEMA_VERSION;
  @IsString() wasm_hash!: string;
  /** When *we* assembled this view — never a verifier's own publication time (AB5). */
  @IsString() updated_at!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AggregatedRegistryVerification)
  source_code_verifications!: AggregatedRegistryVerification[];
  /**
   * Always present, empty when nothing failed: "nobody has a result" and "we could not reach some" are
   * different facts, and an omitted field conflates them.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnavailableVerifier)
  unavailable_verifiers!: UnavailableVerifier[];
  @IsIn(agreementSummaries) agreement!: AgreementSummary;
}

export const AGGREGATE_SCHEMA_MAJOR = 1;

/** CV10: a status we do not recognise is shown as `unverified`, never passed through. */
export function displayStatusOf(
  entry: PeerRegistryVerification,
): ReturnType<typeof registryStatusOrUnverified> {
  return registryStatusOrUnverified(entry.status);
}

/** How the entries relate, over the entries we actually have. */
export function computeAgreement(entries: readonly PeerRegistryVerification[]): AgreementSummary {
  if (entries.length === 0) return "no_data";
  if (entries.length === 1) return "single";

  const statuses = new Set(entries.map((entry) => displayStatusOf(entry)));
  if (statuses.has("verified") && statuses.has("mismatched")) return "disputed";
  if (statuses.size === 1 && statuses.has("verified")) return "unanimous_verified";
  if (statuses.size === 1 && statuses.has("mismatched")) return "unanimous_mismatched";
  return "unverified_only";
}

/**
 * The envelope, from the two things that vary. Both writers — the SDK aggregating live reads and query-svc
 * assembling what its sync retained — built this by hand, which is why `agreement` could have been computed
 * one way in one and another way in the other.
 */
export function aggregateEnvelope(input: {
  wasmHash: string;
  entries: readonly AggregatedRegistryVerification[];
  unavailableVerifiers: readonly UnavailableVerifier[];
}): AggregatedWasmStatus {
  return {
    schema: AGGREGATE_SCHEMA,
    schema_version: AGGREGATE_SCHEMA_VERSION,
    wasm_hash: input.wasmHash,
    // When *we* assembled this view — never a verifier's own publication time (AB5).
    updated_at: new Date().toISOString(),
    source_code_verifications: [...input.entries],
    unavailable_verifiers: [...input.unavailableVerifiers],
    agreement: computeAgreement(input.entries),
  };
}

/**
 * CONSUMER: one unavailable-verifier entry as a hosted aggregate reports it. `reason` is a plain string —
 * a classification added after us must cost the field, not the whole answer.
 */
export class PeerUnavailableVerifier {
  @IsString() url!: string;
  @IsOptional() @IsString() name?: string;
  @IsString() reason!: string;
  @IsOptional() @IsString() error?: string;
}

/**
 * CONSUMER: an aggregate as a Public Query API answers it — the `PeerRegistryStatusObject` split, applied one
 * level up. Any MINOR of the MAJOR we understand, peer entries rather than our own narrowed ones, and
 * `agreement` as a string because CV10's rule (coerce on read, never reject the document) is the same rule.
 */
export class PeerAggregatedWasmStatus {
  @IsOptional() @IsString() schema?: string;
  @SupportedSchemaMajor(AGGREGATE_SCHEMA_MAJOR) schema_version!: string;
  @IsString() wasm_hash!: string;
  @IsString() updated_at!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PeerRegistryVerification)
  source_code_verifications!: PeerRegistryVerification[];
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PeerUnavailableVerifier)
  unavailable_verifiers!: PeerUnavailableVerifier[];
  @IsString() agreement!: string;
}

/** One record of a bulk-load page. Shared by both streams; only the clock behind it differs. */
export class BulkLoadRecord {
  @IsString() wasm_hash!: string;
  @IsString() updated_at!: string;
}

/** Only the record shape differs. */
export const PAGE_SCHEMA = "stellar-verification-page" as const;
export const PAGE_SCHEMA_VERSION = "1.0" as const;
export const PAGE_SCHEMA_MAJOR = 1;

/**
 * A verifier's own bulk-load stream (BL1–BL6), served by `verification-svc` at `GET /api/verification/v1/wasms`
 * and read from `jobs`.
 */
export class OwnBulkLoadPage {
  @Equals(PAGE_SCHEMA) schema!: typeof PAGE_SCHEMA;
  @Equals(PAGE_SCHEMA_VERSION) schema_version!: "1.0";
  @IsIn(["asc", "desc"]) order!: "asc" | "desc";
  /** The next page's cursor; `null` at the end of the stream (BL4). */
  @IsOptional() @IsString() cursor!: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkLoadRecord) records!: BulkLoadRecord[];
}

/** CONSUMER: a peer's page, as `clients/sdk` reads it. */
export class PeerBulkLoadPage {
  @IsOptional() @IsString() schema?: string;
  @SupportedSchemaMajor(PAGE_SCHEMA_MAJOR) schema_version!: string;
  @IsIn(["asc", "desc"]) order!: "asc" | "desc";
  @IsOptional() @IsString() cursor!: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkLoadRecord) records!: BulkLoadRecord[];
}

/** `GET /api/query/v1/wasms` — the aggregated stream (AB1–AB6). */
export class AggregatedBulkLoadPage {
  @Equals(PAGE_SCHEMA) schema!: typeof PAGE_SCHEMA;
  @Equals(PAGE_SCHEMA_VERSION) schema_version!: "1.0";
  @IsIn(["asc", "desc"]) order!: "asc" | "desc";
  @IsOptional() @IsString() cursor!: string | null;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AggregatedWasmStatus)
  records!: AggregatedWasmStatus[];
}
