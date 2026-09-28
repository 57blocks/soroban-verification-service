// Subpath imports, not the barrels: those pull in `node:crypto`, `node:fs` and the AWS SDK.
import {
  parseDto,
  flattenValidationErrors,
  DtoValidationError,
  type ClassConstructor,
} from "@scvs/core/validate";
import {
  PeerTrustedVerifiersList,
  PeerVerifierManifest,
  resultRootOf,
  type PeerTrustedVerifier,
  type ResolvedVerifier,
  VerifierPolicy,
} from "@scvs/storage-layout/shapes";
import { PeerBulkLoadPage } from "@scvs/core/aggregate";
import type { PeerRegistryStatusObject } from "@scvs/core/registry";
import {
  createGuardedFetch,
  normalizePolicy,
  originsFromVerifiers,
  readBoundedBytes,
  FetchPolicyError,
  type FetchPolicy,
  type FetchPolicyInput,
} from "./fetch-policy.js";
import {
  fetchAndVerifyResultUrl,
  type ResultUrlEntry,
  type VerifiedResultUrl,
  type VerifyResultUrlOptions,
} from "./result-urls.js";
import {
  aggregateWasmStatus,
  readStatusObject,
  type AggregatedWasmStatus,
  type StatusObjectReadOptions,
  type UnavailableVerifier,
} from "./registry-read.js";

export type SoveClientOptions = {
  /** The list itself, not a URL. */
  tvl: PeerTrustedVerifiersList;
  /** Absolute base for resolving relative references in TVL entries (`url`, `manifest_url`). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Builds the transport from the resolved policy (e.g. to pin DNS); takes precedence over `fetch`. */
  fetchFactory?: (policy: FetchPolicy) => typeof fetch;
  /** Applied to every fetch this client makes. Default 5_000. */
  timeoutMs?: number;
  /** Defaults to https-only with origins pinned to the TVL's own. Override for a local dev root. */
  policy?: FetchPolicyInput;
};

export interface SoveClient {
  readonly verifiers: readonly ResolvedVerifier[];
  /** Each member's advertised metadata, in list order; never throws and never drops an entry. */
  discover(): Promise<readonly VerifierDiscovery[]>;
  readonly results: {
    /** Fetches and hash-checks an artifact a result points at, under this client's TVL-derived policy. */
     verifyUrl(
      entry: ResultUrlEntry,
      options?: Omit<VerifyResultUrlOptions, "policy" | "fetch">,
    ): Promise<VerifiedResultUrl>;
  };
  /** The Registry API vocabulary: `wasms/<hash>.json` read straight from a verifier's result root. */
  readonly registry: {
    /** Reads a peer's document, accepting any MINOR of the supported MAJOR. */
    statusObject(
      verifier: ResolvedVerifier,
      wasmHash: string,
      options?: StatusObjectReadOptions,
    ): Promise<PeerRegistryStatusObject>;
    /** Every active verifier's, merged, with unreachable ones named rather than dropped. */
    byHash(wasmHash: string, options?: StatusObjectReadOptions): Promise<AggregatedWasmStatus>;
    /** One page of a verifier's own bulk-load stream, from their `bulk_load_url`. */
    bulkLoad(
      verifier: ResolvedVerifier,
      options?: { cursor?: string; limit?: number },
    ): Promise<PeerBulkLoadPage>;
  };
}

export type VerifierDiscovery =
  | {
      verifier: ResolvedVerifier;
      outcome: "available";
      manifest: PeerVerifierManifest;
      /** Present only here: a manifest whose `policy_url` cannot be read is `unavailable`. */
      policy: VerifierPolicy;
    }
  | { verifier: ResolvedVerifier; outcome: "not_advertised" }
  | {
      verifier: ResolvedVerifier;
      outcome: "unavailable";
      reason: UnavailableVerifier["reason"];
      error?: string;
    };

/** Throws if the list is not a valid Trusted Verifiers List — the one place this client throws outward. */
export function newClient(options: SoveClientOptions): SoveClient {
  const tvl = parseSchema(PeerTrustedVerifiersList, options.tvl, "trusted verifiers list");
  const base = options.baseUrl;
  const verifiers = tvl.verifiers.map((verifier, index) =>
    resolveVerifierReference(verifier, base, index),
  );

  const policy = normalizePolicy({
    allowedOrigins: originsFromVerifiers(verifiers),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // Defined fields only: `{ allowedOrigins: undefined }` would erase the line above and allow every origin.
    ...definedOnly(options.policy),
  });
  const impl = options.fetchFactory ? options.fetchFactory(policy) : (options.fetch ?? fetch);
  const guardedFetch = createGuardedFetch(policy, impl);

  const getJson = async (url: string): Promise<unknown> => {
    const response = await guardedFetch(url);
    if (!response.ok) {
      // Nothing reads this body, and an unread one holds its connection open.
      await response.body?.cancel().catch(() => undefined);
      const error = new Error(`Unable to load ${url}: ${response.status}`);
      // `isNotFoundError` reads this, so the status has to survive.
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    const bytes = await readBoundedBytes(response, policy.maxResponseBytes);
    return JSON.parse(decoder.decode(bytes));
  };

  return {
    verifiers,
    async discover() {
      // `allSettled`, not `all`: one peer's failure must not reject the whole fan-out.
      const settled = await Promise.allSettled(
        verifiers.map(async (verifier): Promise<VerifierDiscovery> => {
          const manifestUrl = verifier.manifest_url;
          if (manifestUrl === undefined) return { verifier, outcome: "not_advertised" };
          const manifest = parseSchema(PeerVerifierManifest, await getJson(manifestUrl), manifestUrl);
          const policyUrl = resolveReference(manifestUrl, manifest.policy_url);
          const policy = parseSchema(VerifierPolicy, await getJson(policyUrl), policyUrl);
          return { verifier, outcome: "available", manifest, policy };
        }),
      );
      return settled.map((outcome, index): VerifierDiscovery => {
        if (outcome.status === "fulfilled") return outcome.value;
        const error: unknown = outcome.reason;
        const message = messageOf(error);
        return {
          verifier: verifiers[index],
          outcome: "unavailable",
          reason:
            error instanceof SchemaValidationError
              ? "invalid_response"
              : (classifyFetchError(error) ?? "fetch_failed"),
          ...(message !== undefined ? { error: message } : {}),
        };
      });
    },
    results: {
      verifyUrl(entry, verifyOptions) {
        // `impl`, not `options.fetch`: a `fetchFactory`-only caller must not fall back to the unpinned global `fetch`.
        return fetchAndVerifyResultUrl(entry, {
          ...verifyOptions,
          policy,
          fetch: impl,
        });
      },
    },
    registry: {
      statusObject(verifier, wasmHash, options) {
        return readStatusObject(verifier.url, wasmHash, getJson, options);
      },
      async bulkLoad(verifier, bulkOptions) {
        if (verifier.bulk_load_url === undefined) {
          throw new SchemaValidationError(
            `${verifier.id ?? verifier.url} names no bulk_load_url and cannot be enumerated`,
          );
        }
        const url = new URL(verifier.bulk_load_url);
        url.searchParams.set("order", "asc");
        if (bulkOptions?.cursor !== undefined) url.searchParams.set("cursor", bulkOptions.cursor);
        if (bulkOptions?.limit !== undefined) url.searchParams.set("limit", String(bulkOptions.limit));
        return parseSchema(PeerBulkLoadPage, await getJson(url.toString()), url.toString());
      },
      byHash(wasmHash, options) {
        return aggregateWasmStatus({
          verifiers,
          wasmHash,
          getJson,
          isNotFound: isNotFoundError,
          classifyError: classifyFetchError,
          ...(options?.validation !== undefined ? { validation: options.validation } : {}),
        });
      },
    },
  };
}

const decoder = new TextDecoder();

type JsonGetter = (url: string) => Promise<unknown>;

/** Drops keys explicitly set to `undefined`, which spread would otherwise apply as an erasure. */
export function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function resolveReference(base: string | undefined, reference: string): string {
  if (isAbsolute(reference)) return reference;
  if (base === undefined) {
    throw new SchemaValidationError(
      `Relative reference ${reference} needs an absolute base; pass baseUrl to newClient().`,
    );
  }
  return new URL(reference, base).toString();
}

function isAbsolute(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Unresolvable references are kept as published, so they fail one verifier's fetch, not the whole aggregation. */
function resolveVerifierReference(
  verifier: PeerTrustedVerifier,
  base: string | undefined,
  index: number,
): ResolvedVerifier {
  const root = resultRootOf(verifier);
  if (root === undefined) {
    throw new SchemaValidationError(
      `trusted verifiers list: verifier at index ${index}${verifier.id !== undefined ? ` (${verifier.id})` : ""} names no result root (neither "url" nor "cdn_root")`,
    );
  }
  const { cdn_root: _cdnRoot, ...entry } = verifier;
  return {
    ...entry,
    url: resolveOrKeep(base, root),
    ...(verifier.manifest_url !== undefined
      ? { manifest_url: resolveOrKeep(base, verifier.manifest_url) }
      : {}),
    ...(verifier.bulk_load_url !== undefined
      ? { bulk_load_url: resolveOrKeep(base, verifier.bulk_load_url) }
      : {}),
  };
}

function classifyFetchError(error: unknown): UnavailableVerifier["reason"] | undefined {
  if (error instanceof FetchPolicyError) return "refused";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "timeout";
  }
  // A 200 with a non-JSON body surfaces as `SyntaxError`: the peer served the wrong thing.
  if (error instanceof SyntaxError) return "invalid_response";
  return undefined;
}

function messageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return undefined;
}

function resolveOrKeep(base: string | undefined, reference: string): string {
  try {
    return resolveReference(base, reference);
  } catch {
    return reference;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

function parseSchema<T extends object>(cls: ClassConstructor<T>, value: unknown, source: string): T {
  // An array or a primitive carries no metadata, so `validateSync` returns zero errors for it.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaValidationError(`${source} is not a JSON object`);
  }
  try {
    return parseDto(cls, value);
  } catch (error) {
    if (error instanceof DtoValidationError) {
      throw new SchemaValidationError(formatDtoError(error, source));
    }
    throw error;
  }
}

function formatDtoError(error: DtoValidationError, source: string): string {
  return flattenValidationErrors(error.errors)
    .map((issue) => `${source}.${issue.property} ${Object.values(issue.constraints).join(", ")}`)
    .join("; ");
}
