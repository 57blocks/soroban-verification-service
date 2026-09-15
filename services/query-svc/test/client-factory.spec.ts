import { SoveClientFactory } from "../src/modules/results/client-factory.service.js";
import type { TrustedVerifier } from "soroban-verification-client";

// SoveClientFactory constructed directly, not through the DI container — same approach as
// address-resolver.spec.ts, since the one behavior under test (which transport `allowInsecureResultRoots`
// selects) does not need a running app.

const VERIFIER: TrustedVerifier = {
  id: "local-verifier",
  display_name: "Local",
  url: "http://localhost:5000/public",
  manifest_url: "http://localhost:5000/public/verifier-manifest.json",
  bulk_load_url: "http://localhost:5000/api/verification/v1/wasms",
  status: "active",
};

function configReturning(allowInsecureResultRoots: boolean) {
  return {
    get(key: string) {
      if (key === "allowInsecureResultRoots") return allowInsecureResultRoots;
      if (key === "queryTimeoutMs") return 5_000;
      return undefined;
    },
  };
}

const unreachableFetchFactory = () => {
  throw new Error("pinned fetchFactory must not be invoked when allowInsecureResultRoots relaxes the scheme");
};

describe("SoveClientFactory — allowInsecureResultRoots and the pinned transport", () => {
  it("does not hand an http:-admitting policy to the pinned transport", async () => {
    const factory = new SoveClientFactory(
      configReturning(true) as never,
      undefined as never,
      unreachableFetchFactory,
    );
    // Constructing the client is enough to prove it: createPinnedFetch (unreachableFetchFactory's real-world
    // counterpart) throws at construction time when handed a policy admitting http:, so a client this call
    // returns without throwing proves the relaxed policy went to a different transport.
    await expect(factory.forVerifier(VERIFIER)).resolves.toBeDefined();
  });

  it("keeps the pinned transport when allowInsecureResultRoots is off", async () => {
    let calls = 0;
    const factory = new SoveClientFactory(configReturning(false) as never, undefined as never, (policy) => {
      calls += 1;
      expect(policy.allowedSchemes).toEqual(["https:"]);
      return globalThis.fetch;
    });
    await factory.forVerifier({ ...VERIFIER, url: "https://results.example.com" });
    expect(calls).toBe(1);
  });
});
