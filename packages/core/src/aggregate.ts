import { Type } from "class-transformer";
import { Equals, IsArray, IsIn, IsOptional, IsString, ValidateNested } from "class-validator";
import { PeerRegistryVerification, registryStatusOrUnverified, RegistryVerifier } from "./registry.js";
import { SupportedSchemaMajor } from "./validators/schema-version.js";

export class UnavailableVerifier {
  @IsString() url!: string;
  @IsOptional() @IsString() name?: string;
  @IsIn(["fetch_failed", "invalid_response", "timeout", "refused"])
  reason!: "fetch_failed" | "invalid_response" | "timeout" | "refused";
  @IsOptional() @IsString() error?: string;
}

export const agreementSummaries = [
  "single",
  "unanimous_verified",
  "unanimous_mismatched",
  "disputed",
  "unverified_only",
  "no_data",
] as const;

export type AgreementSummary = (typeof agreementSummaries)[number];

export class AggregatedRegistryVerification extends PeerRegistryVerification {
  @ValidateNested() @Type(() => RegistryVerifier) declare verifier: RegistryVerifier;

  @IsOptional() @IsString() schema_version?: string;

  @IsOptional() @IsString() retrieved_at?: string;
}

export const AGGREGATE_SCHEMA = "stellar-verification-aggregate" as const;

/** The version we emit; never raised to a contributing peer's MINOR. */
export const AGGREGATE_SCHEMA_VERSION = "1.0" as const;

export class AggregatedWasmStatus {
  @Equals(AGGREGATE_SCHEMA) schema!: typeof AGGREGATE_SCHEMA;
  @IsIn([AGGREGATE_SCHEMA_VERSION]) schema_version!: typeof AGGREGATE_SCHEMA_VERSION;
  @IsString() wasm_hash!: string;
  @IsString() updated_at!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AggregatedRegistryVerification)
  source_code_verifications!: AggregatedRegistryVerification[];
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnavailableVerifier)
  unavailable_verifiers!: UnavailableVerifier[];
  @IsIn(agreementSummaries) agreement!: AgreementSummary;
}

export const AGGREGATE_SCHEMA_MAJOR = 1;

export function displayStatusOf(
  entry: PeerRegistryVerification,
): ReturnType<typeof registryStatusOrUnverified> {
  return registryStatusOrUnverified(entry.status);
}

export function computeAgreement(entries: readonly PeerRegistryVerification[]): AgreementSummary {
  if (entries.length === 0) return "no_data";
  if (entries.length === 1) return "single";

  const statuses = new Set(entries.map((entry) => displayStatusOf(entry)));
  if (statuses.has("verified") && statuses.has("mismatched")) return "disputed";
  if (statuses.size === 1 && statuses.has("verified")) return "unanimous_verified";
  if (statuses.size === 1 && statuses.has("mismatched")) return "unanimous_mismatched";
  return "unverified_only";
}

export function aggregateEnvelope(input: {
  wasmHash: string;
  entries: readonly AggregatedRegistryVerification[];
  unavailableVerifiers: readonly UnavailableVerifier[];
}): AggregatedWasmStatus {
  return {
    schema: AGGREGATE_SCHEMA,
    schema_version: AGGREGATE_SCHEMA_VERSION,
    wasm_hash: input.wasmHash,
    updated_at: new Date().toISOString(),
    source_code_verifications: [...input.entries],
    unavailable_verifiers: [...input.unavailableVerifiers],
    agreement: computeAgreement(input.entries),
  };
}

/** `reason` stays a plain string so an unknown classification cannot reject the whole document. */
export class PeerUnavailableVerifier {
  @IsString() url!: string;
  @IsOptional() @IsString() name?: string;
  @IsString() reason!: string;
  @IsOptional() @IsString() error?: string;
}

/** Consumer shape: any MINOR of our MAJOR, and `agreement` read as a string (coerced, never rejected). */
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

export class BulkLoadRecord {
  @IsString() wasm_hash!: string;
  @IsString() updated_at!: string;
}

export const PAGE_SCHEMA = "stellar-verification-page" as const;
export const PAGE_SCHEMA_VERSION = "1.0" as const;
export const PAGE_SCHEMA_MAJOR = 1;

export class OwnBulkLoadPage {
  @Equals(PAGE_SCHEMA) schema!: typeof PAGE_SCHEMA;
  @Equals(PAGE_SCHEMA_VERSION) schema_version!: "1.0";
  @IsIn(["asc", "desc"]) order!: "asc" | "desc";
  @IsOptional() @IsString() cursor!: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkLoadRecord) records!: BulkLoadRecord[];
}

export class PeerBulkLoadPage {
  @IsOptional() @IsString() schema?: string;
  @SupportedSchemaMajor(PAGE_SCHEMA_MAJOR) schema_version!: string;
  @IsIn(["asc", "desc"]) order!: "asc" | "desc";
  @IsOptional() @IsString() cursor!: string | null;
  @IsArray() @ValidateNested({ each: true }) @Type(() => BulkLoadRecord) records!: BulkLoadRecord[];
}

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
