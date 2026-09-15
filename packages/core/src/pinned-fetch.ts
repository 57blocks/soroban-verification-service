import { fetchThroughDestinationPolicy, type HopResponse } from "./policy-bound-fetch.js";
import { FetchPolicyError, UpstreamNotDeliveredError, type FetchPolicy } from "./fetch-policy.js";

/**
 * A `typeof fetch` whose every request is served by `fetchThroughDestinationPolicy` — `https.request` with a
 * `lookup` that validates the DNS answer, not just the URL string, closing the DNS-rebinding gap `checkUrl`
 * alone cannot (see fetch-policy.ts's `checkUrl` and policy-bound-fetch.ts's `pinningLookup`).
 *
 * Node-only: `node:https`/`node:dns` under the hood. Not exported from this package's barrel (`index.ts`) —
 * only from this subpath — for the same reason `rebuild-key.ts` is, and the same reason `clients/sdk` never
 * imports it directly: a caller that bundles for a browser must not pull it in by accident.
 *
 * Meant to sit behind `createGuardedFetch` as its `impl`, so it has to honor the same `redirect` contract that
 * wrapper passes down (`fetch-policy.ts`'s `redirect: policy.followRedirects ? "follow" : "error"`) — a caller
 * with `followRedirects: false` (the policy default) must get a refusal on the first 3xx, not this function
 * silently walking `maxRedirects` hops on its own initiative.
 */
export function createPinnedFetch(
  policy: FetchPolicy,
  maxRedirects = 5,
  /** Injected for tests; production omits it and `fetchThroughDestinationPolicy` uses real sockets. */
  requestImpl?: (url: URL, policy: FetchPolicy, timeoutMs: number) => Promise<HopResponse>,
): typeof fetch {
  // The transport underneath (`node:https`) cannot speak http: at all, so a policy admitting it — the
  // `allowInsecureResultRoots` local-dev relaxation — must not reach this function: refused here, at
  // construction, rather than surfacing as every http: request failing downstream with a confusing "only
  // https: is requested by this fetcher" once traffic starts. A caller in that mode wants no DNS pinning
  // anyway — the relaxation already accepts an unauthenticated result root, so pinning it buys nothing.
  if (policy.allowedSchemes.some((scheme) => scheme !== "https:")) {
    throw new FetchPolicyError(
      `createPinnedFetch only supports an https:-only policy, got allowedSchemes: ${policy.allowedSchemes.join(", ")}`,
    );
  }
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method !== undefined && init.method.toUpperCase() !== "GET") {
      throw new UpstreamNotDeliveredError(`createPinnedFetch only issues GET requests, got ${init.method}`);
    }
    // "manual" is refused rather than silently mistreated as "error": returning the unfollowed 3xx Response is
    // that mode's whole contract, and `fetchThroughDestinationPolicy` has no way to hand one back — it only
    // ever throws or delivers a followed hop's 2xx.
    if (init?.redirect === "manual") {
      throw new UpstreamNotDeliveredError('createPinnedFetch does not support redirect: "manual"');
    }
    const hops = init?.redirect === "error" ? 0 : maxRedirects;

    try {
      const { bytes, finalUrl } = await fetchThroughDestinationPolicy(url, {
        policy,
        maxRedirects: hops,
        ...(requestImpl ? { requestImpl } : {}),
      });
      // `url` is the one field the constructor will not take — the spec makes it a read-only property of the
      // internal response, set by the network layer — so it is defined afterward: `createGuardedFetch`
      // re-checks `response.url` against the policy on the hop that actually answered, which matters after a
      // redirect changed the origin from the one `url` (the request's) named.
      const response = new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
      Object.defineProperty(response, "url", { value: finalUrl, configurable: true });
      return response;
    } catch (error) {
      // Only a real HTTP status the origin returned becomes a Response — the same case a real `fetch` would
      // resolve rather than reject for. Every other failure propagates as a thrown error, which is what
      // classifyFetchError (clients/sdk/src/client.ts) and this method's other callers expect.
      if (error instanceof UpstreamNotDeliveredError && error.status !== undefined) {
        return new Response(null, { status: error.status, statusText: error.message });
      }
      throw error;
    }
  }) as typeof fetch;
}
