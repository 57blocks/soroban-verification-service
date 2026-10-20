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
import { InvalidWasmHashError, normalizeWasmHash } from "./registry-read.js";

/** The path prefix every route hangs off; the client adds it, not the deployment. */
export const QUERY_API_V1 = "/api/query/v1";

/** `code` is query-svc's own error code when it answered, otherwise one of this client's. */
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
  /** The API's origin; a relative base (`""` meaning same origin) works only in a browser. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Applied to every request. Default 5_000. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Defaults to the base URL's own scheme and origin, with the private-range check off. */
  policy?: FetchPolicyInput;
};

/** What both aggregation modes answer, so a consumer can hold either. */
export interface AggregateReader {
  byHash(wasmHash: string): Promise<AggregatedWasmStatus>;
}

export interface HostedQueryClient {
  /** The absolute base every read was built on, after resolution. */
  readonly baseUrl: string;
  /** The list this deployment aggregates across, in the shape `newClient` takes. */
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
      // An origin-sharing console answers an unrouted path with 200 text/html, which is not a refusal.
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
    return parse(PeerAggregatedWasmStatus, body, status, urlFor(path)) as unknown as AggregatedWasmStatus;
  };

  return {
    baseUrl: resolvedBase,
    async verifiers() {
      const { status, body } = await getJson("/verifiers");
      return parse(PeerTrustedVerifiersList, body, status, urlFor("/verifiers"));
    },
    registry: {
      // Encoded so a subject cannot carry `../` out of the prefix.
      async byHash(wasmHash) {
        let normalized: string;
        try {
          normalized = normalizeWasmHash(wasmHash);
        } catch (error) {
          if (!(error instanceof InvalidWasmHashError)) throw error;
          throw new QueryApiError({ status: 0, code: "invalid_wasm_hash", message: error.message });
        }
        return aggregate(`/wasms/${encodeURIComponent(normalized)}`);
      },
      byContract(network, contractId) {
        return aggregate(
          `/contracts/${encodeURIComponent(network)}/${encodeURIComponent(contractId.trim())}`,
        );
      },
    },
  };
}

function resolveBase(prefix: string, given: string): URL {
  try {
    return new URL(prefix);
  } catch {
  }
  // A bare host parses as neither, and resolving it as a path would silently target the page's own origin.
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
  return {
    status: 0,
    code: isTimeout(error) ? "timeout" : "unreachable",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

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
    // `||`, not `??`: HTTP/2 carries no reason phrase, so `statusText` is "".
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
