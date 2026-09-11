import {
  parseDto,
  flattenValidationErrors,
  DtoValidationError,
  type ClassConstructor,
} from "@scvs/core/validate";
import {
  PeerRegistryStatusObject,
  baseProjection,
  registryStatusOrUnverified,
  type PeerRegistryVerification,
} from "@scvs/core/registry";
import type { ResolvedVerifier } from "@scvs/storage-layout/shapes";
import {
  AGGREGATE_SCHEMA,
  type AggregatedRegistryVerification,
  type AggregatedWasmStatus,
  type AgreementSummary,
  type UnavailableVerifier,
} from "@scvs/core/aggregate";
import { wasmStatusKey } from "@scvs/storage-layout/keys";

// Reads and aggregates the Registry API status object. The document shape itself lives in
// `@scvs/core/registry`; this file is the reading, the validation modes and the aggregation.

/** How strictly a peer's document is validated. */
export type RegistryValidationMode =
  /**
   * Base shape with unknown fields tolerated — the published 1.0 schema is closed, so any real document
   * carrying extensions fails strict validation against it.
   */
  | "default"
  /** Validate the base projection instead: unknown fields are dropped before validating, not rejected. */
  | "strict-base";

export type StatusObjectReadOptions = {
  /** Defaults to `"default"`. */
  validation?: RegistryValidationMode;
};

/**
 * One verifier that could not contribute. Identity comes from the TVL, never the peer document — this is
 * exactly the case where the document may be missing or unparseable.
 */
export type { AggregatedWasmStatus, UnavailableVerifier, AgreementSummary };

/** A peer served something that is not a conformant status object. */
export class RegistryDocumentError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} is not a conformant Registry status object: ${detail}`);
    this.name = "RegistryDocumentError";
  }
}

/** The published key for one hash, resolved against a verifier's result root. */
export function statusObjectUrl(resultRoot: string, wasmHash: string): string {
  return new URL(wasmStatusKey(wasmHash.toLowerCase()), resultRootBase(resultRoot)).toString();
}

/** A result root as a joinable base. */
function resultRootBase(resultRoot: string): string {
  const base = new URL(resultRoot);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  return base.toString();
}

/** One verifier's per-hash status object. No `network` parameter: a wasm hash is not chain-scoped. */
export async function readStatusObject(
  resultRoot: string,
  wasmHash: string,
  getJson: (url: string) => Promise<unknown>,
  options: StatusObjectReadOptions = {},
): Promise<PeerRegistryStatusObject> {
  const url = statusObjectUrl(resultRoot, wasmHash);
  return validateStatusObject(await getJson(url), url, options.validation ?? "default");
}

export function validateStatusObject(
  document: unknown,
  source: string,
  mode: RegistryValidationMode = "default",
): PeerRegistryStatusObject {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new RegistryDocumentError(source, "not a JSON object");
  }
  const record = document as Record<string, unknown>;
  const verifications = record.source_code_verifications;
  // `baseProjection` reads each entry with `in`, which throws on a null or a primitive.
  if (Array.isArray(verifications) && verifications.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new RegistryDocumentError(source, "source_code_verifications holds a non-object entry");
  }
  // Projection happens before validation: the point is a document that passes, not a report.
  const candidate = mode === "strict-base" ? baseProjection(record) : document;
  return parseRegistry(PeerRegistryStatusObject, candidate, source);
}

function parseRegistry<T extends object>(cls: ClassConstructor<T>, value: unknown, source: string): T {
  try {
    return parseDto(cls, value);
  } catch (error) {
    if (error instanceof DtoValidationError) {
      // The flat form, or a nested failure reports its constraint list as empty.
      throw new RegistryDocumentError(
        source,
        flattenValidationErrors(error.errors)
          .map((issue) => `${issue.property} ${Object.values(issue.constraints).join(", ")}`)
          .join("; ") || error.message,
      );
    }
    throw error;
  }
}

/**
 * An unrecognised `status` displays as `unverified`. Presentation only — an aggregate forwards what the
 * verifier actually said, so we never become the source of a claim it did not make.
 */
export function displayStatusOf(entry: PeerRegistryVerification): ReturnType<typeof registryStatusOrUnverified> {
  return registryStatusOrUnverified(entry.status);
}

export type AggregateWasmStatusInput = {
  /**
   * Resolved consumer entries, not the producer `TrustedVerifier`: this aggregates over peers' lists, where
   * `manifest_url` and `bulk_load_url` may be absent and only the result root is guaranteed.
   */
  verifiers: readonly ResolvedVerifier[];
  wasmHash: string;
  getJson: (url: string) => Promise<unknown>;
  /** Distinguishes an absent document from an unreachable verifier — see the call site in client.ts. */
  isNotFound: (error: unknown) => boolean;
  /** Anything that is neither absence nor a schema failure; `undefined` falls through to `fetch_failed`. */
  classifyError?: (error: unknown) => UnavailableVerifier["reason"] | undefined;
  validation?: RegistryValidationMode;
};

/** Aggregate across the TVL. */
export async function aggregateWasmStatus(input: AggregateWasmStatusInput): Promise<AggregatedWasmStatus> {
  const active = input.verifiers.filter((verifier) => verifier.status === "active");
  const outcomes = await Promise.all(
    active.map(async (verifier) => {
      try {
        const document = await readStatusObject(verifier.url, input.wasmHash, input.getJson, {
          validation: input.validation,
        });
        // A peer does not get to answer for a hash nobody asked about.
        if (document.wasm_hash.toLowerCase() !== input.wasmHash.toLowerCase()) {
          return unavailable(verifier, "invalid_response", "Document target does not match the query target.");
        }
        return { entries: relayed(document, verifier.url) };
      } catch (error) {
        if (input.isNotFound(error)) return { entries: [] as AggregatedRegistryVerification[] };
        if (error instanceof RegistryDocumentError) {
          return unavailable(verifier, "invalid_response", messageOf(error));
        }
        return unavailable(verifier, input.classifyError?.(error) ?? "fetch_failed", messageOf(error));
      }
    }),
  );

  const entries = outcomes.flatMap((outcome) => ("entries" in outcome ? outcome.entries : []));

  return {
    schema: AGGREGATE_SCHEMA,
    // Ours, not any peer's: this is the version of the aggregate WE emit, and it does not move because a
    // contributing peer declared a higher MINOR.
    schema_version: "1.0",
    wasm_hash: input.wasmHash,
    updated_at: new Date().toISOString(),
    source_code_verifications: entries,
    unavailable_verifiers: outcomes.flatMap((outcome) =>
      "unavailable" in outcome ? [outcome.unavailable] : [],
    ),
    agreement: computeAgreement(entries),
  };
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
 * The `verifier` block passes through untouched — the peer's `url` is the identity, so there is nothing for
 * this layer to assert and nothing to attach beside it.
 */
function relayed(
  document: { schema_version: string; source_code_verifications: readonly PeerRegistryVerification[] },
  resultRoot: string,
): AggregatedRegistryVerification[] {
  return document.source_code_verifications.map((entry) => ({
    ...entry,
    verifier: entry.verifier.url !== undefined ? entry.verifier : { ...entry.verifier, url: resultRoot },
    schema_version: document.schema_version,
  })) as AggregatedRegistryVerification[];
}

function unavailable(
  verifier: ResolvedVerifier,
  reason: UnavailableVerifier["reason"],
  error: string,
): { unavailable: UnavailableVerifier } {
  return {
    unavailable: {
      // The result root identifies here exactly as it does on a contributing entry, so a consumer lines the two
      // lists up on one field rather than two vocabularies.
      url: verifier.url,
      ...(verifier.display_name !== undefined ? { name: verifier.display_name } : {}),
      reason,
      error,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
