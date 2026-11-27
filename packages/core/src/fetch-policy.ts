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

/**
 * Every range that is not the public internet: private, shared, loopback, link-local, documentation, multicast.
 * The same ranges as the builder's egress proxy, except NAT64's well-known prefix (NAT64_WELL_KNOWN below).
 */
const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this host"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud instance metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

const BLOCKED_IPV6: readonly (readonly [string, number])[] = [
  // An address carrying an IPv4 address in its low 32 bits is refused whole, whatever that IPv4 address is:
  // IPv4-compatible ::/96 (which also holds :: and ::1) and IPv4-mapped ::ffff:0:0/96.
  ["::", 96],
  ["::ffff:0:0", 96],
  // NAT64's local-use prefix: where the IPv4 address sits in it is the operator's choice, so it cannot be read out.
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23], // incl. Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
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
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isBlockedIpv4(host);
  const lower = host.toLowerCase().replace(/\.$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

function isBlockedIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  // Not an address at all, so refused rather than let through.
  if (octets.some((octet) => octet > 255)) return true;
  return BLOCKED_IPV4.some(([network, prefix]) => sharesPrefix(octets, network.split(".").map(Number), prefix, 8));
}

/**
 * NAT64's well-known prefix, 64:ff9b::/96 (RFC 6052). DNS64 answers an IPv4-only name with its public address
 * and that address under this prefix, and a lookup is refused if any address is, so the range cannot be refused
 * whole. The address reaches the IPv4 address in its low 32 bits, and is judged as that address.
 */
const NAT64_WELL_KNOWN: readonly number[] = [0x64, 0xff9b, 0, 0, 0, 0];

function isBlockedIpv6(host: string): boolean {
  const groups = ipv6Groups(host);
  // Anything with a colon that does not parse is refused rather than let through.
  if (groups === undefined) return true;
  if (NAT64_WELL_KNOWN.every((group, index) => groups[index] === group)) {
    const [high, low] = groups.slice(6);
    return isBlockedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }
  return BLOCKED_IPV6.some(([network, prefix]) => sharesPrefix(groups, ipv6Groups(network)!, prefix, 16));
}

/** Whether two addresses, as equal-width parts, agree on their first `prefix` bits. */
function sharesPrefix(address: readonly number[], network: readonly number[], prefix: number, width: number): boolean {
  for (let index = 0, remaining = prefix; remaining > 0; index += 1, remaining -= width) {
    const ignored = Math.max(width - remaining, 0);
    if (address[index] >> ignored !== network[index] >> ignored) return false;
  }
  return true;
}

/** The eight 16-bit groups of an IPv6 address, in any spelling: `::` shorthand, a dotted IPv4 tail, a zone id. */
function ipv6Groups(host: string): number[] | undefined {
  let text = host.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${dotted[1]}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups = part.split(":");
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
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
