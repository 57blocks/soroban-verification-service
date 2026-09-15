import assert from "node:assert/strict";
import { normalizePolicy, FetchPolicyError, UpstreamNotDeliveredError } from "./fetch-policy.js";
import { createPinnedFetch } from "./pinned-fetch.js";
import type { HopResponse } from "./policy-bound-fetch.js";

// A standalone script rather than a Jest suite, following registry-test.ts's convention — no package under
// packages/* has a test runner configured. `requestImpl` is injected throughout so this never opens a real
// socket, matching orchestrator-svc's policy-bound-fetch.spec.ts's own approach to the same seam.

const POLICY = normalizePolicy({ allowedSchemes: ["https:"], maxResponseBytes: 1024, timeoutMs: 5_000 });

function bodyOf(body: string, status = 200): HopResponse {
  const handlers = new Map<string, ((chunk?: unknown) => void)[]>();
  const response = {
    statusCode: status,
    headers: {} as Record<string, string>,
    destroy: () => undefined,
    on(event: string, handler: (chunk?: unknown) => void) {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler]);
      if (event === "end") {
        setImmediate(() => {
          for (const onData of handlers.get("data") ?? []) onData(Buffer.from(body));
          for (const onEnd of handlers.get("end") ?? []) onEnd();
        });
      }
      return response;
    },
  };
  return response as unknown as HopResponse;
}

function redirectTo(location: string | undefined, status = 302): HopResponse {
  return { statusCode: status, headers: location ? { location } : {}, destroy: () => undefined } as unknown as HopResponse;
}

async function main(): Promise<void> {
  // A 2xx hop becomes a real Response: status, body and the content-length header all read back correctly,
  // and `url` — the field the constructor cannot take directly — carries the actually-answered hop.
  {
    let calls = 0;
    const impl = createPinnedFetch(POLICY, 5, async () => {
      calls += 1;
      return bodyOf("hello");
    });
    const response = await impl("https://verifier.example.com/manifest.json");
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(response.url, "https://verifier.example.com/manifest.json");
    assert.equal(await response.text(), "hello");
    assert.equal(calls, 1);
  }

  // A non-2xx hop becomes a Response with the real status, not a thrown error — `getJson` (clients/sdk) reads
  // `response.status` to classify a 404 as "not found" rather than "transport failure", and that only works
  // if this layer resolves rather than rejects here.
  {
    const impl = createPinnedFetch(POLICY, 5, async () => bodyOf("not found", 404));
    const response = await impl("https://verifier.example.com/wasms/deadbeef.json");
    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
  }

  // A failure with no HTTP status (a timeout, in this case delivered as an UpstreamNotDeliveredError with no
  // `status`) propagates as a thrown error rather than a synthesised Response — `classifyFetchError` needs the
  // real error identity to tell "timeout" apart from "refused" apart from "the peer answered and it was bad".
  {
    const impl = createPinnedFetch(POLICY, 5, async () => {
      throw new UpstreamNotDeliveredError("Timed out after 5000ms connecting to https://verifier.example.com");
    });
    await assert.rejects(
      () => impl("https://verifier.example.com/manifest.json"),
      (error: unknown) => error instanceof UpstreamNotDeliveredError && error.status === undefined,
    );
  }

  // A private-range address `pinningLookup` would refuse propagates as FetchPolicyError, same as it does for
  // `fetchThroughDestinationPolicy` directly — this wrapper adds no swallowing of its own.
  {
    const impl = createPinnedFetch(POLICY, 5, async () => {
      throw new FetchPolicyError("169.254.169.254 resolves to 1 address(es) in a blocked range");
    });
    await assert.rejects(() => impl("https://verifier.example.com/manifest.json"), FetchPolicyError);
  }

  // redirect: "error" (what createGuardedFetch sends whenever policy.followRedirects is false, the default)
  // must refuse on the very first 3xx rather than silently walking this function's own maxRedirects — that is
  // the whole point of wiring redirect through instead of hard-coding a hop count.
  {
    let calls = 0;
    const impl = createPinnedFetch(POLICY, 5, async () => {
      calls += 1;
      return redirectTo("https://elsewhere.example.com/moved");
    });
    await assert.rejects(
      () => impl("https://verifier.example.com/manifest.json", { redirect: "error" }),
      FetchPolicyError,
    );
    assert.equal(calls, 1, "must not have followed the redirect before refusing");
  }

  {
    const hops = [redirectTo("https://mirror.example.com/manifest.json"), bodyOf("followed")];
    let calls = 0;
    const impl = createPinnedFetch(POLICY, 5, async () => hops[calls++]);
    const response = await impl("https://verifier.example.com/manifest.json");
    assert.equal(await response.text(), "followed");
    assert.equal(calls, 2);
  }

  // "manual" is refused outright rather than silently mistreated as "error" — this function has no way to
  // hand back an unfollowed 3xx Response, which is that mode's actual contract.
  {
    const impl = createPinnedFetch(POLICY, 5, async () => redirectTo("https://elsewhere.example.com/x"));
    await assert.rejects(
      () => impl("https://verifier.example.com/manifest.json", { redirect: "manual" }),
      UpstreamNotDeliveredError,
    );
  }

  {
    let calls = 0;
    const impl = createPinnedFetch(POLICY, 5, async () => {
      calls += 1;
      return bodyOf("unreached");
    });
    await assert.rejects(
      () => impl("https://verifier.example.com/manifest.json", { method: "POST" }),
      UpstreamNotDeliveredError,
    );
    assert.equal(calls, 0);
  }

  console.log("pinned-fetch-test: ok");
}

main();
