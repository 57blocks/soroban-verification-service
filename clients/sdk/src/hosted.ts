// The other half of TRD §8.3: the same queries, answered by a hosted Public Query API instead of by a
// client-side fan-out over result roots. Same output shape, so a consumer switches modes without rewriting
// the code that reads the answer.
import {
  parseDto,
  flattenValidationErrors,
  DtoValidationError,
  type ClassConstructor,
} from "@scvs/core/validate";
import { PeerAggregatedWasmStatus, type AggregatedWasmStatus } from "@scvs/core/aggregate";
import type { Network } from "@scvs/core/enums";
import { PeerTrustedVerifiersList } from "@scvs/storage-layout/shapes";
import {
  createGuardedFetch,
  normalizePolicy,
  readBoundedBytes,
  FetchPolicyError,
  ResponseTooLargeError,
  type FetchPolicyInput,
} from "./fetch-policy.js";
import { definedOnly } from "./client.js";

/** Every route below hangs off this. The prefix is the client's to add, not the deployment's to configure. */
export const QUERY_API_V1 = "/api/query/v1";

/**
 * Why a read did not answer. `code` is the machine-readable one — query-svc's own (`invalid_contract_id`,
 * `contract_not_found`, …) where it answered, and one of this client's where it did not.
 */
export type QueryApiFailure = {
  /** The HTTP status, or `0` when there was no response at all. */
  status: number;
  code: string;
  message: string;
};

/** The one error type every method here throws. */
export class QueryApiError extends Error {
  readonly failure: QueryApiFailure;

  constructor(failure: QueryApiFailure) {
    super(failure.message);
    this.name = "QueryApiError";
    this.failure = failure;
  }
}

/** Any thrown value as a failure, so a caller's error path has one shape to read. */
export function queryApiFailureOf(error: unknown): QueryApiFailure {
  if (error instanceof QueryApiError) return error.failure;
  return {
    status: 0,
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

export type HostedClientOptions = {
  /**
   * The API's origin. Absolute anywhere; relative — `""` meaning "same origin as this page" — only in a
   * browser, which is what resolves it.
   */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Applied to every request. Default 5_000. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Defaults to the base URL's own scheme and origin, with the private-range check off: this endpoint is one
   * the caller named, so the guard that exists for a peer-chosen URL would only refuse a localhost API.
   */
  policy?: FetchPolicyInput;
};

/** What both aggregation modes answer, so a consumer can hold either — TRD §8.3's "without code change". */
export interface AggregateReader {
  byHash(wasmHash: string): Promise<AggregatedWasmStatus>;
}

export interface HostedQueryClient {
  /** The absolute base every read was built on, after resolution. */
  readonly baseUrl: string;
  /**
   * The list this deployment aggregates across, in the shape `newClient` takes — so the hosted list can seed
   * a client-side client.
   */
  verifiers(): Promise<PeerTrustedVerifiersList>;
  readonly registry: AggregateReader & {
    /** Every trusted verifier's answer for whatever Wasm a contract address currently holds. */
    byContract(network: Network, contractId: string): Promise<AggregatedWasmStatus>;
  };
}

/** Throws if `baseUrl` cannot be resolved to an origin — the one place this client throws outward. */
export function newHostedClient(options: HostedClientOptions): HostedQueryClient {
  const prefix = options.baseUrl.replace(/\/+$/, "");
  const base = resolveBase(prefix, options.baseUrl);
  const policy = normalizePolicy({
    allowedSchemes: [base.protocol],
    allowedOrigins: [base.origin],
    blockPrivateRanges: false,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    // Stated fields only: `{ allowedOrigins: undefined }` would erase the pin above.
    ...definedOnly(options.policy),
  });
  // Late-bound: a test double or a polyfill installed after construction must still be what this calls.
  const impl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const guarded = createGuardedFetch(policy, impl);

  const urlFor = (path: string) => new URL(`${prefix}${QUERY_API_V1}${path}`, base).toString();
  // Origin plus whatever path the base carried, which is not `base.origin` when the API sits behind a gateway.
  const resolvedBase = new URL(prefix === "" ? "/" : `${prefix}/`, base).toString().replace(/\/$/, "");

  const getJson = async (path: string): Promise<{ status: number; body: unknown }> => {
    const url = urlFor(path);
    let response: Response;
    try {
      response = await guarded(url);
    } catch (error) {
      throw new QueryApiError(transportFailure(error));
    }

    const text = await bodyText(response, policy.maxResponseBytes);
    if (!response.ok) throw new QueryApiError(declaredFailure(response, text));

    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      // The success path needs this as much as the failure path does, and for a sharper reason: a console
      // sharing the API's origin answers an unrouted path with 200 text/html, which is not a refusal.
      throw new QueryApiError({
        status: response.status,
        code: "invalid_response",
        message:
          `the query API answered ${response.status} with a body that is not JSON — ` +
          `the request may have been answered by something other than the query API: ${url}`,
      });
    }
  };

  const aggregate = async (path: string): Promise<AggregatedWasmStatus> => {
    const { status, body } = await getJson(path);
    // Validated as a peer's document, returned in the producer type: they differ only where a consumer has to
    // tolerate more than we publish, and none of those differences is a field a reader dereferences blind.
    return parse(PeerAggregatedWasmStatus, body, status, urlFor(path)) as unknown as AggregatedWasmStatus;
  };

  return {
    baseUrl: resolvedBase,
    async verifiers() {
      const { status, body } = await getJson("/verifiers");
      return parse(PeerTrustedVerifiersList, body, status, urlFor("/verifiers"));
    },
    registry: {
      // Lower-cased and encoded: the route is case-insensitive about a hash, and a subject is not allowed to
      // carry `../` out of the prefix it was joined onto.
      byHash(wasmHash) {
        return aggregate(`/wasms/${encodeURIComponent(wasmHash.trim().toLowerCase())}`);
      },
      byContract(network, contractId) {
        return aggregate(
          `/contracts/${encodeURIComponent(network)}/${encodeURIComponent(contractId.trim())}`,
        );
      },
    },
  };
}

/** Absolute as given; a relative base is the browser's own origin, and nothing else can resolve one. */
function resolveBase(prefix: string, given: string): URL {
  try {
    return new URL(prefix);
  } catch {
    // Falls through: `""` and `/gateway` both land here.
  }
  // A bare host — `api.example.com` — parses as neither, and resolving it as a path would silently build
  // a URL on the page's own origin.
  if (prefix !== "" && !prefix.startsWith("/")) {
    throw new FetchPolicyError(
      `baseUrl ${JSON.stringify(given)} is neither an absolute URL nor a root-relative path; ` +
        "an origin needs its scheme",
    );
  }
  // The DOM lib types `location` as always present. In Node it is not.
  const href = typeof location === "undefined" ? undefined : location.href;
  if (href === undefined) {
    throw new FetchPolicyError(
      `baseUrl ${JSON.stringify(given)} is relative and there is no document to resolve it against; ` +
        "pass an absolute origin outside a browser",
    );
  }
  return new URL(href);
}

const decoder = new TextDecoder();

/** Bounded before it is read: an error body is as unbounded as a success body. */
async function bodyText(response: Response, maxResponseBytes: number): Promise<string> {
  try {
    return decoder.decode(await readBoundedBytes(response, maxResponseBytes));
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new QueryApiError({ status: response.status, code: "response_too_large", message: error.message });
    }
    throw new QueryApiError(transportFailure(error));
  }
}

function transportFailure(error: unknown): QueryApiFailure {
  if (error instanceof QueryApiError) return error.failure;
  if (error instanceof FetchPolicyError) {
    return { status: 0, code: "refused", message: error.message };
  }
  // No status and no code of its own. Naming it keeps it distinguishable from a service that answered with a
  // refusal, which is a different thing to tell a reader.
  return {
    status: 0,
    code: isTimeout(error) ? "timeout" : "unreachable",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The declared error envelope where there is one, a synthesised failure where there is not. */
function declaredFailure(response: Response, text: string): QueryApiFailure {
  let body: { error?: unknown; message?: unknown } | undefined;
  try {
    body = JSON.parse(text) as { error?: unknown; message?: unknown };
  } catch {
    body = undefined;
  }
  const declared = typeof body?.error === "string" ? body.error : undefined;
  return {
    status: response.status,
    code: declared ?? `http_${response.status}`,
    // `||`, not `??`: HTTP/2 carries no reason phrase, so `statusText` is "" in every deployed environment
    // and a refusal would render as a blank line.
    message:
      (typeof body?.message === "string" ? body.message : "") ||
      response.statusText ||
      `the query API answered ${response.status}`,
  };
}

function parse<T extends object>(
  cls: ClassConstructor<T>,
  value: unknown,
  status: number,
  source: string,
): T {
  // An array or a primitive carries no metadata, so `validateSync` returns zero errors for it.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QueryApiError({
      status,
      code: "invalid_response",
      message: `${source} answered something that is not a JSON object`,
    });
  }
  try {
    return parseDto(cls, value);
  } catch (error) {
    if (error instanceof DtoValidationError) {
      throw new QueryApiError({
        status,
        code: "invalid_response",
        message: `${source} is not a conformant response: ${formatDtoError(error)}`,
      });
    }
    throw error;
  }
}

function formatDtoError(error: DtoValidationError): string {
  return (
    flattenValidationErrors(error.errors)
      .map((issue) => `${issue.property} ${Object.values(issue.constraints).join(", ")}`)
      .join("; ") || error.message
  );
}
