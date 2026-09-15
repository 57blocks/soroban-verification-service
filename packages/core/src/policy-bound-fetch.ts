import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { FetchPolicyError, ResponseTooLargeError, UpstreamNotDeliveredError, checkUrl, isBlockedIpLiteral } from "./fetch-policy.js";
import type { FetchPolicy } from "./fetch-policy.js";

/**
 * Not `fetch`, because two things this needs cannot be asked of Node's global client, and both were the actual
 * exposure:
 */

/** 3xx codes that carry a `Location` worth following. 304/305/306 are not redirects to a new resource. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One resolved address, in `dns.lookup(…, { all: true })`'s shape. */
export type ResolvedAddress = { address: string; family: number };

/** `dns.lookup`'s `all: true` form, narrowed to what `pinningLookup` needs. */
export type AddressResolver = (
  hostname: string,
  options: Record<string, unknown>,
  callback: (error: Error | null, addresses?: ResolvedAddress[]) => void,
) => void;

const defaultResolver: AddressResolver = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    callback(error, addresses as ResolvedAddress[] | undefined);
  });
};

export type PolicyBoundResponse = {
  bytes: Uint8Array;
  /** The hop the bytes actually came from — every hop on the way was policy-checked before it was requested. */
  finalUrl: string;
};

/** What one hop returns. Narrowed to what the loop reads, so a test double need not be a real socket. */
export type HopResponse = Pick<IncomingMessage, "statusCode" | "headers" | "destroy"> &
  Partial<Pick<IncomingMessage, "on">>;

export type PolicyBoundFetchOptions = {
  policy: FetchPolicy;
  /**
   * Hops followed before the attempt is refused. Exhausting it is a **refusal**, never a silent stop with
   * whatever the last response happened to be.
   */
  maxRedirects: number;
  /** Injected for tests; production omits it and gets `requestOnce`. */
  requestImpl?: (url: URL, policy: FetchPolicy, timeoutMs: number) => Promise<HopResponse>;
};

/** Fetches `url` under `policy`, following redirects only through hosts the policy admits. */
export async function fetchThroughDestinationPolicy(
  url: string,
  options: PolicyBoundFetchOptions,
): Promise<PolicyBoundResponse> {
  const { policy, maxRedirects, requestImpl = requestOnce } = options;
  // One deadline for the whole chain, not per hop: `maxRedirects` hops at `timeoutMs` each would let a hostile
  // peer hold the publish path open for a multiple of the bound the caller thought it set.
  const deadline = Date.now() + policy.timeoutMs;

  let current = checkUrl(policy, url);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new UpstreamNotDeliveredError(`Timed out after ${policy.timeoutMs}ms following ${hop} redirect(s)`);
    }

    const response = await requestImpl(current, policy, remaining);
    const status = response.statusCode ?? 0;

    if (REDIRECT_STATUSES.has(status)) {
      const location = response.headers.location;
      // Never read a redirect body: a 302 carrying 50 MiB would otherwise cost us the full transfer.
      response.destroy();
      if (!location) {
        throw new UpstreamNotDeliveredError(`Status ${status} from ${current.origin} carried no Location header`);
      }
      // Resolved against the current hop, because a relative `Location` is legal and common.
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new UpstreamNotDeliveredError(`Status ${status} from ${current.origin} carried an unusable Location`);
      }
      current = checkUrl(policy, next.toString());
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw new UpstreamNotDeliveredError(`Status ${status} from ${current.origin}`, status);
    }

    return {
      bytes: await readBounded(response as IncomingMessage, policy.maxResponseBytes),
      finalUrl: current.toString(),
    };
  }

  throw new FetchPolicyError(`Refused after ${maxRedirects} redirect(s) from the original URL`);
}

/** A single request, connected only to addresses `pinningLookup` approved. */
function requestOnce(url: URL, policy: FetchPolicy, timeoutMs: number): Promise<IncomingMessage> {
  if (url.protocol !== "https:") {
    throw new FetchPolicyError(`Only https: is requested by this fetcher, got ${url.protocol}`);
  }
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        // The pin. Passing the URL (not an address) keeps SNI and certificate validation on the hostname —
        // verified: `tls authorized: true`, `servername: <hostname>`.
        lookup: pinningLookup(policy),
        timeout: timeoutMs,
        // `https.globalAgent` has `keepAlive: true` by default since Node 19, so using it would leave a live
        // socket to a **submitter-chosen host** open after a one-shot archive download that will never be
        // repeated.
        agent: false,
        // Nothing about the submitter's URL should make us send anything but a plain GET.
        headers: { "user-agent": "scvs-orchestrator", accept: "*/*" },
      },
      resolve,
    );
    // `timeout` only arms the socket-idle timer; without this the request hangs rather than aborting.
    request.on("timeout", () => {
      request.destroy(new UpstreamNotDeliveredError(`Timed out after ${timeoutMs}ms connecting to ${url.origin}`));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * The `lookup` handed to `https.request`: resolve once, validate every address, hand back exactly what was
 * validated.
 */
export function pinningLookup(policy: FetchPolicy, resolver: AddressResolver = defaultResolver): LookupFunction {
  return ((hostname: string, options: Record<string, unknown>, callback: (...args: unknown[]) => void) => {
    // `all: true` regardless of what was asked, so every address the resolver offers is inspected.
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      // Must match the resolver error passed through above — both mean "this name has no address", so a caller
      // must not be left to map them to two different reason codes.
      if (!addresses || addresses.length === 0) {
        callback(new UpstreamNotDeliveredError(`${hostname} resolved to no addresses`));
        return;
      }
      if (policy.blockPrivateRanges) {
        // A hostile resolver returning one public and one private address must not get a connection attempt on
        // the strength of ordering.
        const blocked = addresses.filter((entry) => isBlockedIpLiteral(entry.address));
        if (blocked.length > 0) {
          callback(
            new FetchPolicyError(
              `${hostname} resolves to ${blocked.length} address(es) in a blocked range ` +
                `(${blocked.map((entry) => entry.address).join(", ")})`,
            ),
          );
          return;
        }
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  }) as unknown as LookupFunction;
}

/** Reads the body with a running count, the same discipline as `@scvs/core`'s `readBoundedBytes`. */
async function readBounded(response: IncomingMessage, maxResponseBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    response.destroy();
    throw new ResponseTooLargeError(`Response declares ${declared} bytes, over the ${maxResponseBytes}-byte limit`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<Uint8Array>((resolve, reject) => {
    response.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxResponseBytes) {
        // Destroyed rather than left draining: a hostile peer's stream should not outlive our interest.
        response.destroy();
        reject(new ResponseTooLargeError(`Response exceeded the ${maxResponseBytes}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    response.on("error", reject);
  });
}
