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
  SEP58_HEX_SHA256,
  type PeerRegistryVerification,
} from "@scvs/core/registry";
import type { ResolvedVerifier } from "@scvs/storage-layout/shapes";
import {
  aggregateEnvelope,
  computeAgreement,
  displayStatusOf,
  type AggregatedRegistryVerification,
  type AggregatedWasmStatus,
  type AgreementSummary,
  type UnavailableVerifier,
} from "@scvs/core/aggregate";
import { wasmStatusKey } from "@scvs/storage-layout/keys";

/** How strictly a peer's document is validated. */
export type RegistryValidationMode =
  /** Base shape with unknown fields tolerated. */
  | "default"
  /** Validate the base projection instead: unknown fields are dropped before validating, not rejected. */
  | "strict-base";

export type StatusObjectReadOptions = {
  /** Defaults to `"default"`. */
  validation?: RegistryValidationMode;
};

export type { AggregatedWasmStatus, UnavailableVerifier, AgreementSummary };

/** A peer served something that is not a conformant status object. */
export class RegistryDocumentError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} is not a conformant Registry status object: ${detail}`);
    this.name = "RegistryDocumentError";
  }
}

/** Thrown before any request for a hash that is not 64 hexadecimal characters. */
export class InvalidWasmHashError extends Error {
  constructor(wasmHash: string) {
    super(`${JSON.stringify(wasmHash)} is not a Wasm hash: expected 64 hexadecimal characters`);
    this.name = "InvalidWasmHashError";
  }
}

/** Lowercased, in either case on the way in; anything else throws `InvalidWasmHashError`. */
export function normalizeWasmHash(wasmHash: string): string {
  const normalized = wasmHash.trim().toLowerCase();
  if (!SEP58_HEX_SHA256.test(normalized)) throw new InvalidWasmHashError(wasmHash);
  return normalized;
}

/** The published key for one hash, resolved against a verifier's result root. */
export function statusObjectUrl(resultRoot: string, wasmHash: string): string {
  return new URL(wasmStatusKey(normalizeWasmHash(wasmHash)), resultRootBase(resultRoot)).toString();
}

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

export type AggregateWasmStatusInput = {
  verifiers: readonly ResolvedVerifier[];
  wasmHash: string;
  getJson: (url: string) => Promise<unknown>;
  /** Distinguishes an absent document from an unreachable verifier. */
  isNotFound: (error: unknown) => boolean;
  /** Anything that is neither absence nor a schema failure; `undefined` falls through to `fetch_failed`. */
  classifyError?: (error: unknown) => UnavailableVerifier["reason"] | undefined;
  validation?: RegistryValidationMode;
};

/** Aggregate across the TVL. */
export async function aggregateWasmStatus(input: AggregateWasmStatusInput): Promise<AggregatedWasmStatus> {
  const wasmHash = normalizeWasmHash(input.wasmHash);
  const active = input.verifiers.filter((verifier) => verifier.status === "active");
  const outcomes = await Promise.all(
    active.map(async (verifier) => {
      try {
        const document = await readStatusObject(verifier.url, wasmHash, input.getJson, {
          validation: input.validation,
        });
        // A peer does not get to answer for a hash nobody asked about.
        if (document.wasm_hash.toLowerCase() !== wasmHash) {
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

  return aggregateEnvelope({
    wasmHash,
    entries: outcomes.flatMap((outcome) => ("entries" in outcome ? outcome.entries : [])),
    unavailableVerifiers: outcomes.flatMap((outcome) =>
      "unavailable" in outcome ? [outcome.unavailable] : [],
    ),
  });
}

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
