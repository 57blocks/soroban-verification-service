import { selectBuildMechanism } from "../src/modules/verification-pipeline/mechanism-routing.util.js";

const TRUSTED_IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;
const UNTRUSTED_IMAGE = `ghcr.io/someone/their-builder@sha256:${"b".repeat(64)}`;
const COMPOSED_IDENTITY = `sha256:${"c".repeat(64)}`;

const eligible = {
  chainRecipe: {
    bldimg: TRUSTED_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--package", "hello-world"],
  },
  rebuildRecipe: { bldarg: ["contract", "build"], bldopt: ["--package", "hello-world"] },
  environmentIdentity: TRUSTED_IMAGE,
};

describe("selectBuildMechanism", () => {
  it("sandboxes an on-chain recipe in a policy-accepted image, still naming it as the chain's", () => {
    expect(selectBuildMechanism(eligible)).toEqual({
      mode: "build",
      reason: "on_chain_recipe_in_trusted_image",
    });
  });

  it("routes a contract that records no image to the sandbox", () => {
    expect(
      selectBuildMechanism({
        ...eligible,
        chainRecipe: { ...eligible.chainRecipe, bldimg: undefined },
        environmentIdentity: COMPOSED_IDENTITY,
      }),
    ).toEqual({ mode: "build", reason: "no_chain_recorded_image" });
  });

  it("routes a chain-named image that policy does not accept to the sandbox", () => {
    expect(
      selectBuildMechanism({
        ...eligible,
        chainRecipe: { ...eligible.chainRecipe, bldimg: UNTRUSTED_IMAGE },
        environmentIdentity: UNTRUSTED_IMAGE,
      }),
    ).toEqual({ mode: "build", reason: "image_not_policy_accepted" });
  });

  it("routes a composed environment to the sandbox even when the chain named a trusted image", () => {
    expect(
      selectBuildMechanism({ ...eligible, environmentIdentity: COMPOSED_IDENTITY }),
    ).toEqual({ mode: "build", reason: "environment_is_composed" });
  });

  describe("a recipe that deviates from the chain's is not an on-chain recipe", () => {
    it("rejects an added option", () => {
      expect(
        selectBuildMechanism({
          ...eligible,
          rebuildRecipe: {
            bldarg: ["contract", "build"],
            bldopt: ["--package", "hello-world", "--features", "backdoor"],
          },
        }).reason,
      ).toBe("recipe_deviates_from_chain");
    });

    it("rejects a dropped option", () => {
      expect(
        selectBuildMechanism({
          ...eligible,
          rebuildRecipe: { bldarg: ["contract", "build"], bldopt: [] },
        }).reason,
      ).toBe("recipe_deviates_from_chain");
    });

    it("rejects different entry-point arguments", () => {
      expect(
        selectBuildMechanism({
          ...eligible,
          rebuildRecipe: { bldarg: ["contract", "build", "--extra"], bldopt: eligible.chainRecipe.bldopt },
        }).reason,
      ).toBe("recipe_deviates_from_chain");
    });

    it("rejects a reordering, because this rule is about provenance and not equivalence", () => {
      expect(
        selectBuildMechanism({
          ...eligible,
          rebuildRecipe: { bldarg: ["contract", "build"], bldopt: ["hello-world", "--package"] },
        }).reason,
      ).toBe("recipe_deviates_from_chain");
    });
  });

  it("treats an absent list and an empty one as the same recipe", () => {
    expect(
      selectBuildMechanism({
        chainRecipe: { bldimg: TRUSTED_IMAGE },
        rebuildRecipe: { bldarg: [], bldopt: [] },
        environmentIdentity: TRUSTED_IMAGE,
      }),
    ).toEqual({ mode: "build", reason: "on_chain_recipe_in_trusted_image" });
  });

  it("★ maps every input to the sandbox, and names each deviation distinctly", () => {
    const cases = [
      [{ chainRecipe: { ...eligible.chainRecipe, bldimg: undefined } }, "no_chain_recorded_image"],
      [{ chainRecipe: { ...eligible.chainRecipe, bldimg: UNTRUSTED_IMAGE } }, "image_not_policy_accepted"],
      [{ environmentIdentity: COMPOSED_IDENTITY }, "environment_is_composed"],
      [{ rebuildRecipe: { bldarg: ["cargo", "build"], bldopt: [] } }, "recipe_deviates_from_chain"],
      [{}, "on_chain_recipe_in_trusted_image"],
    ] as const;
    for (const [deviation, reason] of cases) {
      expect(selectBuildMechanism({ ...eligible, ...deviation })).toEqual({ mode: "build", reason });
    }
  });
});

describe("PA1 routes every input to the sandbox (the retirement's precondition)", () => {
  const CHAIN_IMAGE = `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`;

  it.each([
    ["no chain image at all", { chainRecipe: {}, environmentIdentity: `sha256:${"d".repeat(64)}` }],
    [
      "a chain image the policy rejects",
      { chainRecipe: { bldimg: "docker.io/stellar/stellar-cli:latest" }, environmentIdentity: "docker.io/stellar/stellar-cli:latest" },
    ],
    [
      "a composed environment standing in for the chain's image",
      { chainRecipe: { bldimg: CHAIN_IMAGE }, environmentIdentity: `sha256:${"e".repeat(64)}` },
    ],
    [
      "a recipe that deviates from the chain's",
      { chainRecipe: { bldimg: CHAIN_IMAGE, bldopt: ["--locked"] }, environmentIdentity: CHAIN_IMAGE },
    ],
    [
      "the chain's own recipe in the image the chain named",
      { chainRecipe: { bldimg: CHAIN_IMAGE }, environmentIdentity: CHAIN_IMAGE },
    ],
  ])("%s → build", (_label, input) => {
    const routing = selectBuildMechanism({
      rebuildRecipe: {},
      ...(input as unknown as Parameters<typeof selectBuildMechanism>[0]),
    });
    expect(routing.mode).toBe("build");
  });

  it("★ still distinguishes why, because `reason` outlives the routing decision as recipe_source", () => {
    const reasons = new Set(
      [
        { chainRecipe: {}, environmentIdentity: `sha256:${"d".repeat(64)}` },
        { chainRecipe: { bldimg: "docker.io/stellar/stellar-cli:latest" }, environmentIdentity: "x" },
        { chainRecipe: { bldimg: CHAIN_IMAGE }, environmentIdentity: `sha256:${"e".repeat(64)}` },
        { chainRecipe: { bldimg: CHAIN_IMAGE, bldopt: ["--locked"] }, environmentIdentity: CHAIN_IMAGE },
        { chainRecipe: { bldimg: CHAIN_IMAGE }, environmentIdentity: CHAIN_IMAGE },
      ].map(
        (input) =>
          selectBuildMechanism({
            rebuildRecipe: {},
            ...(input as unknown as Parameters<typeof selectBuildMechanism>[0]),
          }).reason,
      ),
    );
    expect(reasons.size).toBe(5);
  });
});
