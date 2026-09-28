import { fetchThroughDestinationPolicy, type HopResponse } from "./policy-bound-fetch.js";
import { FetchPolicyError, UpstreamNotDeliveredError, type FetchPolicy } from "./fetch-policy.js";

export function canPin(policy: Pick<FetchPolicy, "allowedSchemes">): boolean {
  return !policy.allowedSchemes.some((scheme) => scheme !== "https:");
}

/** Node-only (`node:https`): not exported from the barrel, so browser bundles never pull it in. */
export function createPinnedFetch(
  policy: FetchPolicy,
  maxRedirects = 5,
  requestImpl?: (url: URL, policy: FetchPolicy, timeoutMs: number) => Promise<HopResponse>,
): typeof fetch {
  if (!canPin(policy)) {
    throw new FetchPolicyError(
      `createPinnedFetch only supports an https:-only policy, got allowedSchemes: ${policy.allowedSchemes.join(", ")}`,
    );
  }
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method !== undefined && init.method.toUpperCase() !== "GET") {
      throw new UpstreamNotDeliveredError(`createPinnedFetch only issues GET requests, got ${init.method}`);
    }
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
      // `Response` cannot take `url` in its constructor, so it is defined afterwards for `createGuardedFetch` to re-check.
      const response = new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
      Object.defineProperty(response, "url", { value: finalUrl, configurable: true });
      return response;
    } catch (error) {
      if (error instanceof UpstreamNotDeliveredError && error.status !== undefined) {
        return new Response(null, { status: error.status, statusText: error.message });
      }
      throw error;
    }
  }) as typeof fetch;
}
