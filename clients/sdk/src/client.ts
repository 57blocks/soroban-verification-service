// Subpath imports, not the barrels: those re-export `node:crypto`, `node:fs` and the AWS SDK, none of which can
// reach a browser bundle.
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

// Runs in Node and in a browser: nothing here touches a `node:` builtin, and a caller who wants files supplies
// a `fetch` that reads them.

export type SoveClientOptions = {
  /** The list itself, not a URL. A caller whose list lives at a URL fetches it and passes the object. */
  tvl: PeerTrustedVerifiersList;
  /** Absolute base for resolving relative references in TVL entries (`url`, `manifest_url`). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Applied to every fetch this client makes. Default 5_000. */
  timeoutMs?: number;
  /** Defaults to https-only with origins pinned to the TVL's own. Override for a local dev root. */
  policy?: FetchPolicyInput;
};

export interface SoveClient {
  readonly verifiers: readonly ResolvedVerifier[];
  /**
   * The public metadata each TVL member advertises beside its result root, one outcome per member, in the
   * list's own order. Never throws and never drops an entry: a verifier that advertises no manifest and one
   * whose manifest cannot be read are different answers, and both are answers.
   */
  discover(): Promise<readonly VerifierDiscovery[]>;
  readonly results: {
    /**
     * Fetches an artifact a result points at, under this client's own policy — which is the only way the
     * TVL-derived origin allowlist reaches a peer-supplied URL.
     */
     verifyUrl(
      entry: ResultUrlEntry,
      options?: Omit<VerifyResultUrlOptions, "policy" | "fetch">,
    ): Promise<VerifiedResultUrl>;
  };
  /** The Registry API vocabulary: `wasms/<hash>.json` read straight from a verifier's result root. */
  readonly registry: {
    /**
     * `PeerRegistryStatusObject`, not `RegistryStatusObject`: every document this client reads is a peer's, so
     * its `schema_version` is any MINOR of the MAJOR we understand (SO7) rather than the exact `"1.0"` our own
     * published documents declare (CV1).
     */
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

/**
 * One member's discovery outcome. A discriminated union rather than `{ manifest?, policy? }`: optional fields
 * would collapse "advertises nothing" (a conformance class — `manifest_url` is OPTIONAL, and nothing this SEP
 * specifies is read out of a manifest), "advertised but unreachable", and "served something unparseable" into
 * one absent value, which is the same conflation `unavailable_verifiers` exists to prevent in the aggregate.
 */
export type VerifierDiscovery =
  | {
      verifier: ResolvedVerifier;
      outcome: "available";
      manifest: PeerVerifierManifest;
      /** Present only here: a manifest whose `policy_url` cannot be read is `unavailable`, not half-available. */
      policy: VerifierPolicy;
    }
  | { verifier: ResolvedVerifier; outcome: "not_advertised" }
  | {
      verifier: ResolvedVerifier;
      outcome: "unavailable";
      /** Reusing the aggregate's vocabulary, so a caller classifies both fan-outs the same way. */
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

  // From the resolved entries, so a relative `url` contributes the origin its `baseUrl` gave it.
  const policy = normalizePolicy({
    allowedOrigins: originsFromVerifiers(verifiers),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // Stated fields only: `{ allowedOrigins: undefined }` would otherwise erase the line above and leave every
    // origin allowed.
    ...definedOnly(options.policy),
  });
  const guardedFetch = createGuardedFetch(policy, options.fetch ?? fetch);

  const getJson = async (url: string): Promise<unknown> => {
    const response = await guardedFetch(url);
    if (!response.ok) {
      // Nothing reads this body, and an unread one holds its connection open.
      await response.body?.cancel().catch(() => undefined);
      const error = new Error(`Unable to load ${url}: ${response.status}`);
      // `errorResult` classifies `not_found` off this, so the status has to survive.
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    // Bounded before parsing: an endless body must not hold the aggregation open.
    const bytes = await readBoundedBytes(response, policy.maxResponseBytes);
    return JSON.parse(decoder.decode(bytes));
  };

  return {
    verifiers,
    async discover() {
      // `allSettled`, not `all`: one peer's dead manifest host used to reject the whole fan-out, which is the
      // one failure mode a discovery call across independent operators must not have.
      const settled = await Promise.allSettled(
        verifiers.map(async (verifier): Promise<VerifierDiscovery> => {
          const manifestUrl = verifier.manifest_url;
          if (manifestUrl === undefined) return { verifier, outcome: "not_advertised" };
          // The peer class: a manifest still spelling its root `cdn_root` is a lagging rollout, not
          // a verifier to drop.
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
        return fetchAndVerifyResultUrl(entry, {
          ...verifyOptions,
          policy,
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
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
            // `url` is the identity the SEP defines; `id` is optional and may not be there.
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
          // Mapped here because this layer owns the transport; registry-read imports no policy types.
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

// A base URL subsumes the already-absolute and root-relative cases, so no `node:path` is needed.
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

/**
 * An unresolvable reference is kept as published rather than thrown: it fails this verifier's own fetch, as an
 * entry, instead of failing the whole aggregation before it starts.
 */
function resolveVerifierReference(
  verifier: PeerTrustedVerifier,
  base: string | undefined,
  index: number,
): ResolvedVerifier {
  const root = resultRootOf(verifier);
  if (root === undefined) {
    // Named by position, not by `id`: `id` is optional, and an entry with no result root has no identity to
    // name it by either — the position is the only thing that points a list author at the right entry.
    throw new SchemaValidationError(
      `trusted verifiers list: verifier at index ${index}${verifier.id !== undefined ? ` (${verifier.id})` : ""} names no result root (neither "url" nor "cdn_root")`,
    );
  }
  // `cdn_root` is dropped rather than carried: past this point there is one spelling of the result root, so
  // no later reader has to know both.
  const { cdn_root: _cdnRoot, ...entry } = verifier;
  return {
    ...entry,
    url: resolveOrKeep(base, root),
    // Resolved when advertised, absent when not: resolution cannot invent a reference the peer never made.
    ...(verifier.manifest_url !== undefined
      ? { manifest_url: resolveOrKeep(base, verifier.manifest_url) }
      : {}),
    ...(verifier.bulk_load_url !== undefined
      ? { bulk_load_url: resolveOrKeep(base, verifier.bulk_load_url) }
      : {}),
  };
}

/** Transport failures, in the aggregate's own vocabulary. Shared by `byHash` and `discover`. */
function classifyFetchError(error: unknown): UnavailableVerifier["reason"] | undefined {
  if (error instanceof FetchPolicyError) return "refused";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "timeout";
  }
  // `getJson` parses, so a peer answering 200 with an HTML error page or a truncated body surfaces as
  // `JSON.parse`'s SyntaxError. That is a peer serving the wrong thing, not a peer we could not reach —
  // classifying it `fetch_failed` would have an operator checking the network for a content problem.
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

/**
 * Validation is delegated to the `@scvs/storage-layout` class-validator classes — the single source of truth
 * for these shapes.
 */
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
