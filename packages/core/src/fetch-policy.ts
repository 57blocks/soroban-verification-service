export type FetchPolicy = {
  allowedSchemes: readonly string[];
  /** Empty means no origin restriction. */
  allowedOrigins: readonly string[];
  blockPrivateRanges: boolean;
  followRedirects: boolean;
  maxResponseBytes: number;
  timeoutMs: number;
};

export type FetchPolicyInput = Partial<FetchPolicy>;

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class FetchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchPolicyError";
  }
}

export class UpstreamNotDeliveredError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamNotDeliveredError";
    this.status = status;
  }
}

export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

const BLOCKED_IPV4 = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./, // link-local, incl. cloud instance metadata
  /^0\./, // "this host"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

export function normalizePolicy(input: FetchPolicyInput = {}): FetchPolicy {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

export function originsFromVerifiers(
  verifiers: readonly { url: string; manifest_url?: string; bulk_load_url?: string }[],
): string[] {
  const origins = new Set<string>();
  for (const verifier of verifiers) {
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
    return undefined;
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
    // `file:`, `data:` and similar all have origin "null"; allowlisting one would admit them all.
    if (parsed.origin === "null") {
      throw new FetchPolicyError(`Scheme ${parsed.protocol} has no identifiable origin: ${url}`);
    }
    if (!policy.allowedOrigins.includes(parsed.origin)) {
      throw new FetchPolicyError(`Origin ${parsed.origin} is not in the trusted-verifier origins: ${url}`);
    }
  }
  return parsed;
}

export function isBlockedIpLiteral(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host.includes(":")) return isBlockedIpv6(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return BLOCKED_IPV4.some((range) => range.test(host));
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

/** WHATWG URL rewrites `::ffff:169.254.169.254` to `::ffff:a9fe:a9fe`, so both spellings are checked. */
function mappedIpv4(lower: string): string | undefined {
  const dotted = /^(?:0*:)*0*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];

  const hex = /^(?:0*:)*0*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function createGuardedFetch(policy: FetchPolicy, impl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const checked = checkUrl(policy, url);
    // A `Request` is forwarded whole to keep its method, headers and body.
    const target = typeof input === "string" || input instanceof URL ? checked.toString() : input;
    const response = await impl(target, {
      ...init,
      redirect: policy.followRedirects ? (init?.redirect ?? "follow") : "error",
      // Combined with, never replaced by, the caller's signal.
      signal: init?.signal
        ? anySignal([init.signal, AbortSignal.timeout(policy.timeoutMs)])
        : AbortSignal.timeout(policy.timeoutMs),
    });
    if (response.url) checkUrl(policy, response.url);
    return response;
  }) as typeof fetch;
}

/** `AbortSignal.any` needs Node 20.3+ / Safari 17.4+. */
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
