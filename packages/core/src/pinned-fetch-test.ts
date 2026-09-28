import assert from "node:assert/strict";
import { normalizePolicy, FetchPolicyError, UpstreamNotDeliveredError } from "./fetch-policy.js";
import { canPin, createPinnedFetch } from "./pinned-fetch.js";
import type { HopResponse } from "./policy-bound-fetch.js";

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
  assert.equal(canPin(normalizePolicy({ allowedSchemes: ["https:"] })), true);
  assert.equal(canPin(normalizePolicy({ allowedSchemes: ["https:", "http:"] })), false);
  assert.equal(canPin(normalizePolicy({ allowedSchemes: ["http:"] })), false);

  {
    let calls = 0;
    assert.throws(
      () =>
        createPinnedFetch(normalizePolicy({ allowedSchemes: ["https:", "http:"] }), 5, async () => {
          calls += 1;
          return bodyOf("unreached");
        }),
      FetchPolicyError,
    );
    assert.equal(calls, 0);
  }

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

  {
    const impl = createPinnedFetch(POLICY, 5, async () => bodyOf("not found", 404));
    const response = await impl("https://verifier.example.com/wasms/deadbeef.json");
    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
  }

  {
    const impl = createPinnedFetch(POLICY, 5, async () => {
      throw new UpstreamNotDeliveredError("Timed out after 5000ms connecting to https://verifier.example.com");
    });
    await assert.rejects(
      () => impl("https://verifier.example.com/manifest.json"),
      (error: unknown) => error instanceof UpstreamNotDeliveredError && error.status === undefined,
    );
  }

  {
    const impl = createPinnedFetch(POLICY, 5, async () => {
      throw new FetchPolicyError("169.254.169.254 resolves to 1 address(es) in a blocked range");
    });
    await assert.rejects(() => impl("https://verifier.example.com/manifest.json"), FetchPolicyError);
  }

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
