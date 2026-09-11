import {
  BuildEnvironmentResolutionError,
  CURRENT_COMPOSE_TEMPLATE_VERSION,
  DeterministicBuildEnvironmentResolver,
} from "../src/modules/build-environments/deterministic-build-environment-resolver.service.js";

/** Phase 2's own tests — chain-derived-input classification only, per `build-environment-resolver.ts`'s header. */
const VALID_STELLAR_CLI_IMAGE = "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64);
const OTHER_DIGEST_PINNED_IMAGE = "docker.io/library/debian@sha256:" + "b".repeat(64);

describe("DeterministicBuildEnvironmentResolver", () => {
  const resolver = new DeterministicBuildEnvironmentResolver();

  it("resolves a chain-injected, policy-clean bldimg as chain_named/sdf_trusted", async () => {
    const resolution = await resolver.resolve({ sep58Image: VALID_STELLAR_CLI_IMAGE });
    expect(resolution).toEqual({
      kind: "chain_named",
      image: VALID_STELLAR_CLI_IMAGE,
      trustLevel: "sdf_trusted",
    });
  });

  it("fails closed, rather than misrouting, when a sep58Image fails image policy", async () => {
    // A caller must run evaluateBuildImage() before ever asking about a sep58Image at all — see the resolver's
    // own doc comment.
    await expect(resolver.resolve({ sep58Image: OTHER_DIGEST_PINNED_IMAGE })).rejects.toThrow(
      BuildEnvironmentResolutionError,
    );
  });

  it("reports missing_toolchain_pair when neither a chain-named image nor a pair was derived", async () => {
    const resolution = await resolver.resolve({});
    expect(resolution).toEqual({ kind: "unsupported", reason: "missing_toolchain_pair" });
  });

  it("reports undated_nightly for the corpus-scan nightly shape, never routing it to compose", async () => {
    const resolution = await resolver.resolve({
      pair: { cliver: "25.1.0", rsver: "1.95.0-nightly" },
    });
    expect(resolution).toEqual({ kind: "unsupported", reason: "undated_nightly" });
  });

  it("resolves every addressable cli-legacy pair to a compose intent", async () => {
    const pair = {
      cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
      rsver: "1.96.0",
    };
    const resolution = await resolver.resolve({ pair });
    expect(resolution).toEqual({
      kind: "compose",
      intent: { pair, template_version: CURRENT_COMPOSE_TEMPLATE_VERSION },
      trustLevel: "upstream_pinned",
    });
    // The point of the resolve/materialize split: nothing on this branch requires having fetched a component
    // checksum, so there is no `components`/`recipe` field to assert the absence of.
  });

  it("treats a chain-named image as taking precedence over a pair when both were derived", async () => {
    // Both cannot legitimately co-occur in practice.
    const resolution = await resolver.resolve({
      sep58Image: VALID_STELLAR_CLI_IMAGE,
      pair: { cliver: "25.1.0", rsver: "1.95.0" },
    });
    expect(resolution.kind).toBe("chain_named");
  });
});
