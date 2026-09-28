import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { FetchPolicyError, ResponseTooLargeError, UpstreamNotDeliveredError, checkUrl, isBlockedIpLiteral } from "./fetch-policy.js";
import type { FetchPolicy } from "./fetch-policy.js";

/** 304/305/306 are not redirects to a new resource. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type ResolvedAddress = { address: string; family: number };

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
  finalUrl: string;
};

export type HopResponse = Pick<IncomingMessage, "statusCode" | "headers" | "destroy"> &
  Partial<Pick<IncomingMessage, "on">>;

export type PolicyBoundFetchOptions = {
  policy: FetchPolicy;
  maxRedirects: number;
  requestImpl?: (url: URL, policy: FetchPolicy, timeoutMs: number) => Promise<HopResponse>;
};

export async function fetchThroughDestinationPolicy(
  url: string,
  options: PolicyBoundFetchOptions,
): Promise<PolicyBoundResponse> {
  const { policy, maxRedirects, requestImpl = requestOnce } = options;
  // One deadline for the whole redirect chain, not per hop.
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
      // Never read a redirect body.
      response.destroy();
      if (!location) {
        throw new UpstreamNotDeliveredError(`Status ${status} from ${current.origin} carried no Location header`, status);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new UpstreamNotDeliveredError(`Status ${status} from ${current.origin} carried an unusable Location`, status);
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

function requestOnce(url: URL, policy: FetchPolicy, timeoutMs: number): Promise<IncomingMessage> {
  if (url.protocol !== "https:") {
    throw new FetchPolicyError(`Only https: is requested by this fetcher, got ${url.protocol}`);
  }
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        // The pin: addresses are validated in `lookup`, while SNI and certificate checks stay on the hostname.
        lookup: pinningLookup(policy),
        timeout: timeoutMs,
        // `https.globalAgent` keeps sockets alive; never pool a connection to a submitter-chosen host.
        agent: false,
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

/** Resolves once, validates every address, and hands back exactly the validated addresses. */
export function pinningLookup(policy: FetchPolicy, resolver: AddressResolver = defaultResolver): LookupFunction {
  return ((hostname: string, options: Record<string, unknown>, callback: (...args: unknown[]) => void) => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      if (!addresses || addresses.length === 0) {
        callback(new UpstreamNotDeliveredError(`${hostname} resolved to no addresses`));
        return;
      }
      if (policy.blockPrivateRanges) {
        // Refused if any address is blocked, whatever the order.
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
