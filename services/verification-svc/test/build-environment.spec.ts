import { CURRENT_COMPOSE_TEMPLATE_VERSION } from "@scvs/core";
import { classifyPreflightBuildEnvironment } from "../src/modules/preflight/build-environment.js";

const VALID_STELLAR_CLI_IMAGE = "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64);
const OTHER_DIGEST_PINNED_IMAGE = "docker.io/library/debian@sha256:" + "b".repeat(64);

describe("classifyPreflightBuildEnvironment", () => {
  it("resolves cli-58 to chain_named when the recorded bldimg clears image policy", () => {
    const resolution = classifyPreflightBuildEnvironment(
      { bldimg: VALID_STELLAR_CLI_IMAGE, raw_entries: [] },
      0,
    );
    expect(resolution).toEqual({
      kind: "chain_named",
      image: VALID_STELLAR_CLI_IMAGE,
      trustLevel: "sdf_trusted",
    });
  });

  it("reports chain_named_policy_rejected, not a thrown error, when the recorded bldimg fails policy", () => {
    const resolution = classifyPreflightBuildEnvironment(
      { bldimg: OTHER_DIGEST_PINNED_IMAGE, raw_entries: [] },
      0,
    );
    expect(resolution.kind).toBe("chain_named_policy_rejected");
  });

  it("reports missing_toolchain_pair for cli-none (no bldimg, no cliver-bearing section)", () => {
    const resolution = classifyPreflightBuildEnvironment({ raw_entries: [] }, undefined);
    expect(resolution).toEqual({ kind: "unsupported", reason: "missing_toolchain_pair" });
  });

  it("derives the pair from raw_entries and resolves every addressable cli-legacy pair to compose", () => {
    const pair = {
      cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
      rsver: "1.96.0",
    };
    const resolution = classifyPreflightBuildEnvironment(
      { raw_entries: [] },
      pair,
    );
    expect(resolution).toEqual({
      kind: "compose",
      intent: {
        pair,
        template_version: CURRENT_COMPOSE_TEMPLATE_VERSION,
      },
      trustLevel: "upstream_pinned",
    });
  });

  it("reports undated_nightly for a cli-legacy pair with an undated nightly rsver", () => {
    const resolution = classifyPreflightBuildEnvironment(
      { raw_entries: [] },
      { cliver: "25.1.0", rsver: "1.95.0-nightly" },
    );
    expect(resolution).toEqual({ kind: "unsupported", reason: "undated_nightly" });
  });

  it("never asks about a pair once a chain-named image is present", () => {
    const resolution = classifyPreflightBuildEnvironment(
      { bldimg: VALID_STELLAR_CLI_IMAGE, raw_entries: [] },
      { cliver: "25.1.0", rsver: "1.95.0" },
    );
    expect(resolution.kind).toBe("chain_named");
  });
});
