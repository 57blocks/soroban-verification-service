// The destination policy for an outbound fetch of a URL we did not choose.

export type FetchPolicy = {
  /** Default `["https:"]`. `http:` only when a caller opts in — localhost dev roots are the case. */
  allowedSchemes: readonly string[];
  /** Origin allowlist; `newClient` fills it from the TVL. Empty means no origin restriction. */
  allowedOrigins: readonly string[];
  /** Refuse IP-literal hosts in loopback, RFC1918, link-local and CGNAT ranges. Default `true`. */
  blockPrivateRanges: boolean;
  /** Default `false`, which refuses a redirect outright. */
  followRedirects: boolean;
  /** Refuse a response body larger than this. Default 1 MiB. */
  maxResponseBytes: number;
  /** Enforced with `AbortSignal.timeout`, which cancels the request. Must be > 0. */
  timeoutMs: number;
};

export type FetchPolicyInput = Partial<FetchPolicy>;

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** We would not go there: thrown before the request it refuses, so a caller can tell it from a failure. */
export class FetchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchPolicyError";
  }
}

/**
 * The destination was admitted and produced no bytes anyway: a non-2xx, a timeout, a name that resolves to
 * nothing.
 */
export class UpstreamNotDeliveredError extends Error {
  /** Set only when the failure is a real HTTP status the origin returned — absent for a timeout, a name with
   *  no address, or any other failure that never reached that layer. `createPinnedFetch` reads this to answer
   *  with the status itself (so a peer's 404 stays a 404, not a generic refusal) rather than throwing. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamNotDeliveredError";
    this.status = status;
  }
}

/** Separate from `FetchPolicyError`: only detectable mid-transfer, so the request did happen. */
export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

/** Literals only; a name resolving into one of these is the rebinding case above. */
const BLOCKED_IPV4 = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./, // link-local, incl. cloud instance metadata
  /^0\./, // "this host"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC6598 carrier-grade NAT
];

export function normalizePolicy(input: FetchPolicyInput = {}): FetchPolicy {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Rejected rather than read as "no timeout": that reading left a hostile peer unbounded.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new FetchPolicyError(`timeoutMs must be a positive number, got ${String(input.timeoutMs)}`);
  }
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new FetchPolicyError(
      `maxResponseBytes must be a positive number, got ${String(input.maxResponseBytes)}`,
    );
  }
  return {
    allowedSchemes: input.allowedSchemes ?? ["https:"],
    allowedOrigins: input.allowedOrigins ?? [],
    blockPrivateRanges: input.blockPrivateRanges ?? true,
    followRedirects: input.followRedirects ?? false,
    maxResponseBytes,
    timeoutMs,
  };
}

/** The origins every TVL entry names — the default allowlist. */
export function originsFromVerifiers(
  verifiers: readonly { url: string; manifest_url?: string; bulk_load_url?: string }[],
): string[] {
  const origins = new Set<string>();
  for (const verifier of verifiers) {
    // The bulk route usually sits on a different host than the static root — a CDN serves one and an
    // application the other, ours included — so leaving it out would have the policy refuse a peer.
    for (const reference of [verifier.url, verifier.manifest_url, verifier.bulk_load_url]) {
      if (reference === undefined) continue;
      const origin = originOf(reference);
      if (origin !== undefined) origins.add(origin);
    }
  }
  return [...origins];
}

function originOf(reference: string): string | undefined {
  try {
    return new URL(reference).origin;
  } catch {
    return undefined; // a relative reference contributes no origin; `baseUrl` resolution supplies it
  }
}

export function checkUrl(policy: FetchPolicy, url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchPolicyError(`Not an absolute URL: ${url}`);
  }
  if (!policy.allowedSchemes.includes(parsed.protocol)) {
    throw new FetchPolicyError(
      `Scheme ${parsed.protocol} is not allowed (allowed: ${policy.allowedSchemes.join(", ")}): ${url}`,
    );
  }
  if (policy.blockPrivateRanges && isBlockedIpLiteral(parsed.hostname)) {
    throw new FetchPolicyError(`Host ${parsed.hostname} is in a blocked address range: ${url}`);
  }
  if (policy.allowedOrigins.length > 0) {
    // `file:`, `data:` and friends all serialize to the string "null", so an allowlist holding one would admit
    // every other.
    if (parsed.origin === "null") {
      throw new FetchPolicyError(`Scheme ${parsed.protocol} has no identifiable origin: ${url}`);
    }
    if (!policy.allowedOrigins.includes(parsed.origin)) {
      throw new FetchPolicyError(`Origin ${parsed.origin} is not in the trusted-verifier origins: ${url}`);
    }
  }
  return parsed;
}

/**
 * Whether an IP literal — or a static loopback alias, which no lookup can make public — is in a range this
 * policy refuses.
 */
export function isBlockedIpLiteral(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host.includes(":")) return isBlockedIpv6(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return BLOCKED_IPV4.some((range) => range.test(host));
  // Static aliases for the addresses above, not the rebinding case: no lookup can make them public.
  const lower = host.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique-local fc00::/7
  const mapped = mappedIpv4(lower);
  return mapped !== undefined && BLOCKED_IPV4.some((range) => range.test(mapped));
}

/**
 * Dotted-quad inside an IPv4-mapped IPv6 host. Both spellings are needed: WHATWG URL normalizes
 * `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe`, so a dotted-only check never fires.
 */
function mappedIpv4(lower: string): string | undefined {
  const dotted = /^(?:0*:)*0*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];

  const hex = /^(?:0*:)*0*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** Policy-checks the request URL, and refuses a redirect unless the policy allows one. */
export function createGuardedFetch(policy: FetchPolicy, impl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const checked = checkUrl(policy, url);
    // A `Request` carries method, headers and a body; forwarding it whole is what keeps them.
    const target = typeof input === "string" || input instanceof URL ? checked.toString() : input;
    const response = await impl(target, {
      ...init,
      redirect: policy.followRedirects ? (init?.redirect ?? "follow") : "error",
      // Composed, not replaced: a caller's signal must not remove the policy's timeout.
      signal: init?.signal
        ? anySignal([init.signal, AbortSignal.timeout(policy.timeoutMs)])
        : AbortSignal.timeout(policy.timeoutMs),
    });
    // `response.url` is empty on some hand-rolled test doubles; only re-check what the runtime gave us.
    if (response.url) checkUrl(policy, response.url);
    return response;
  }) as typeof fetch;
}

/** `AbortSignal.any` is Node 20.3 and Safari 17.4; this package supports older. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([...signals]);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** `Content-Length` is only an early exit; the running count is the actual bound. */
export async function readBoundedBytes(response: Response, maxResponseBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    throw new ResponseTooLargeError(
      `Response declares ${declared} bytes, over the ${maxResponseBytes}-byte limit: ${response.url}`,
    );
  }

  const body = response.body;
  if (!body) {
    // Nothing to meter without a stream, so the bound is checked after buffering.
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxResponseBytes) {
      throw new ResponseTooLargeError(
        `Response is ${buffer.byteLength} bytes, over the ${maxResponseBytes}-byte limit: ${response.url}`,
      );
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new ResponseTooLargeError(
          `Response exceeded the ${maxResponseBytes}-byte limit: ${response.url}`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Cancel so a hostile peer's still-open body does not outlive our interest in it.
    await reader.cancel().catch(() => undefined);
  }

  if (chunks.length === 1) return chunks[0];

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
