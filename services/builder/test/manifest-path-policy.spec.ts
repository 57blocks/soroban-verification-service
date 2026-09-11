import { extractManifestPath, resolveContainerManifestPath } from "@scvs/core";
import { resolveManifestPath } from "../src/modules/builder/build-options.js";
import { buildRecipeFromJob } from "../src/modules/builder/builder.service.js";

/**
 * `--manifest-path` sits in `BLDOPT_VALUE_FLAGS_HANDLED_ELSEWHERE`, so it is stripped from the replayed
 * `bldopt` on the promise that something else forwards it.
 */

const IMAGE = `docker.io/example/soroban@sha256:${"a".repeat(64)}`;

describe("extractManifestPath", () => {
  it("reads both spellings the reference emits", () => {
    expect(extractManifestPath(["--manifest-path=contracts/a/Cargo.toml"])).toBe("contracts/a/Cargo.toml");
    expect(extractManifestPath(["--manifest-path", "contracts/b/Cargo.toml"])).toBe("contracts/b/Cargo.toml");
  });

  it("returns undefined when the recipe records none, which is cli-legacy's normal case", () => {
    // cli-legacy carries no `bldopt` at all — it records `cliver` and no SEP-58 recipe.
    expect(extractManifestPath([])).toBeUndefined();
    expect(extractManifestPath(undefined)).toBeUndefined();
    expect(extractManifestPath(["-p", "contract-a", "--meta", "k=v"])).toBeUndefined();
  });

  it("unescapes the recorded value like every other bldopt reader", () => {
    // `bldopt` entries are shell-escaped (BE4); reading them raw would corrupt any quoted path.
    expect(extractManifestPath(["--manifest-path='contracts/with space/Cargo.toml'"])).toBe(
      "contracts/with space/Cargo.toml",
    );
  });
});

describe("buildRecipeFromJob: workspace_path comes from the recipe, not the host", () => {
  it("carries the recorded manifest path", () => {
    const recipe = buildRecipeFromJob({
      image_digest: IMAGE,
      build_options: ["--manifest-path=contracts/a/Cargo.toml", "-p", "contract-a"],
    });
    expect(recipe.workspace_path).toBe("contracts/a/Cargo.toml");
  });

  it("defaults to the workspace root when the recipe records no manifest path", () => {
    expect(buildRecipeFromJob({ image_digest: IMAGE }).workspace_path).toBe(".");
    expect(buildRecipeFromJob({ image_digest: IMAGE, build_options: [] }).workspace_path).toBe(".");
  });

  it("never yields an absolute path, whatever the job carries", () => {
    // The invariant that matters more than any single case: whatever `bldopt` says, this field is what the
    // container resolver consumes, and an absolute value there is a guaranteed failure.
    for (const bldopt of [[], ["-p", "x"], ["--manifest-path=a/Cargo.toml"], ["--meta", "k=v"]]) {
      const recipe = buildRecipeFromJob({ image_digest: IMAGE, build_options: bldopt });
      expect(recipe.workspace_path.startsWith("/")).toBe(false);
    }
  });
});

describe("resolveContainerManifestPath: S12's validation point", () => {
  it("maps a relative manifest under the mount, normalised", () => {
    expect(resolveContainerManifestPath("contracts/a/Cargo.toml")).toEqual({
      ok: true,
      path: "/source/contracts/a/Cargo.toml",
    });
    // A directory is completed to its Cargo.toml.
    expect(resolveContainerManifestPath("contracts/a")).toEqual({ ok: true, path: "/source/contracts/a/Cargo.toml" });
    expect(resolveContainerManifestPath(".")).toEqual({ ok: true, path: "/source/Cargo.toml" });
    expect(resolveContainerManifestPath("")).toEqual({ ok: true, path: "/source/Cargo.toml" });
  });

  it("refuses an absolute path", () => {
    expect(resolveContainerManifestPath("/tmp/scvs-src-abc/Cargo.toml")).toMatchObject({
      ok: false,
      reason: "absolute_manifest_path_not_supported",
    });
  });

  it("refuses a path that escapes the mount, rather than clamping it", () => {
    // Clamping would build *something* for a recipe that asked for something else — a wrong verdict rather than
    // a failure.
    for (const escape of ["../Cargo.toml", "../../etc/Cargo.toml", "contracts/../../outside/Cargo.toml", ".."]) {
      expect(resolveContainerManifestPath(escape)).toMatchObject({
        ok: false,
        reason: "manifest_path_escapes_source",
      });
    }
  });

  it("allows a `..` that stays inside the tree, because the check is on the outcome", () => {
    // `a/../b` normalises to `b`. Refusing on the spelling would reject a legitimate recorded value.
    expect(resolveContainerManifestPath("contracts/../packages/x/Cargo.toml")).toEqual({
      ok: true,
      path: "/source/packages/x/Cargo.toml",
    });
  });
});

describe("resolveManifestPath: the host side agrees with the container side", () => {
  it("joins a relative recorded path onto the source root", () => {
    // The two resolvers must read `workspace_path` the same way; when they disagree the rebuild either stats
    // one file and builds another, or fails for a reason that names the wrong thing.
    expect(resolveManifestPath("/src", "contracts/a/Cargo.toml")).toBe("/src/contracts/a/Cargo.toml");
    expect(resolveManifestPath("/src", "contracts/a")).toBe("/src/contracts/a/Cargo.toml");
    expect(resolveManifestPath("/src", ".")).toBe("/src/Cargo.toml");
  });
});
