import { legacyCustodyFromReport } from "../src/modules/publish/arweave-archive.service.js";

describe("legacyCustodyFromReport", () => {
  it("reads the top-level image_trust_level when present", () => {
    const report = JSON.stringify({
      image_trust_level: "official_trusted",
      build_recipe: { build_environment: { trust_level: "upstream_pinned" } },
    });

    expect(legacyCustodyFromReport(report)).toEqual({ imageTrustLevel: "official_trusted" });
  });

  it("falls back to the nested build_recipe.build_environment.trust_level for a pre-existing report", () => {
    const report = JSON.stringify({
      build_recipe: { build_environment: { trust_level: "upstream_pinned" } },
    });

    expect(legacyCustodyFromReport(report)).toEqual({ imageTrustLevel: "upstream_pinned" });
  });

  it("returns undefined when neither path names a recognised trust level", () => {
    expect(legacyCustodyFromReport(JSON.stringify({}))).toBeUndefined();
    expect(legacyCustodyFromReport(JSON.stringify({ image_trust_level: "not_a_real_level" }))).toBeUndefined();
  });

  it("returns undefined for unparseable bytes rather than throwing", () => {
    expect(legacyCustodyFromReport("not json")).toBeUndefined();
  });
});
