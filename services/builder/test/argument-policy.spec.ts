import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADDED_ARGUMENTS,
  CONTAINER_CLI_ENTRYPOINT,
  assembleBuildCommand,
  resolveAddedEnvironment,
} from "../src/modules/builder/argument-policy.js";
import { CONTAINER_ARTIFACT_DIR, CONTAINER_OUT_DIR } from "../src/modules/builder/artifact-selection.js";
import { FIXTURES } from "./differential/fixtures.js";

describe("ADDED_ARGUMENTS", () => {
  it("documents every verifier-added argument with a fixture", () => {
    const fixtureIds = new Set(FIXTURES.map((fixture) => fixture.id));

    for (const entry of ADDED_ARGUMENTS) {
      expect(entry.rule).toBe("BE11");
      expect(entry.justification.trim().length).toBeGreaterThan(20);
      expect(fixtureIds.has(entry.byteNeutralFixture)).toBe(true);
    }
  });

  it("keeps --locked scoped to acquisition, not the build command", () => {
    const locked = ADDED_ARGUMENTS.find((entry) => entry.flag === "--locked");

    expect(locked?.stage).toBe("acquisition");
    expect(readFileSync(join(process.cwd(), "src/modules/builder/sandbox-runtime.ts"), "utf8")).toContain(
      '"--locked"',
    );
  });
});

describe("assembleBuildCommand", () => {
  it("does not add --locked unless the recipe recorded it", () => {
    const command = assembleBuildCommand({
      dockerArgs: ["docker", "run", "--rm", "-v", `/tmp/out:${CONTAINER_OUT_DIR}`],
      env: [],
      image: "example@sha256:" + "a".repeat(64),
      leading: ["contract", "build"],
      forwarded: ["--optimize"],
      manifestPath: "/source/contracts/Cargo.toml",
      packageName: "contract-a",
    });

    expect(command).not.toContain("--locked");
    expect(command).toEqual(
      expect.arrayContaining([
        "--manifest-path",
        "/source/contracts/Cargo.toml",
        "--package",
        "contract-a",
        "--out-dir",
        CONTAINER_ARTIFACT_DIR,
      ]),
    );
  });

  it("names the CLI as the entrypoint, on the docker side of the image", () => {
    const image = "example@sha256:" + "c".repeat(64);
    const command = assembleBuildCommand({
      dockerArgs: ["docker", "run", "--rm"],
      env: [],
      image,
      leading: ["contract", "build"],
      forwarded: [],
      manifestPath: "/source/Cargo.toml",
    });

    const at = command.indexOf(image);
    expect(command[at - 2]).toBe("--entrypoint");
    expect(command[at - 1]).toBe(CONTAINER_CLI_ENTRYPOINT);
    expect(command.slice(at + 1)).toEqual(expect.arrayContaining(["contract", "build"]));
  });

  it("replays a recorded --locked instead of adding its own", () => {
    const command = assembleBuildCommand({
      dockerArgs: ["docker", "run", "--rm"],
      env: [],
      image: "example@sha256:" + "b".repeat(64),
      leading: ["contract", "build"],
      forwarded: ["--locked"],
      manifestPath: "/source/Cargo.toml",
    });

    expect(command.filter((token) => token === "--locked")).toHaveLength(1);
  });
});

describe("resolveAddedEnvironment", () => {
  it("suppresses the default target dir when the recipe records --target-dir", () => {
    const result = resolveAddedEnvironment({
      recordedEnv: [],
      recordedBuildArgs: ["--target-dir", "/source/target"],
      cargoHome: `${CONTAINER_OUT_DIR}/cargo-home`,
      cargoNetOffline: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.some((entry) => entry.startsWith("CARGO_TARGET_DIR="))).toBe(false);
      expect(result.skipped).toContainEqual({
        flag: "CARGO_TARGET_DIR",
        reason: "recorded recipe controls target-directory",
      });
    }
  });

  it("accepts a recorded offline value that agrees with the deviation", () => {
    const result = resolveAddedEnvironment({
      recordedEnv: ["CARGO_NET_OFFLINE=true"],
      recordedBuildArgs: [],
      cargoNetOffline: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.filter((entry) => entry.startsWith("CARGO_NET_OFFLINE="))).toEqual([
        "CARGO_NET_OFFLINE=true",
      ]);
    }
  });

  it("fails when a recorded env value would switch off offline mode", () => {
    const result = resolveAddedEnvironment({
      recordedEnv: ["CARGO_NET_OFFLINE=false"],
      recordedBuildArgs: [],
      cargoNetOffline: true,
    });

    expect(result).toEqual({
      ok: false,
      reason: "offline_mode_conflicts_with_deviation",
      detail:
        "The recorded bldopt sets CARGO_NET_OFFLINE to a value other than true, which would disable the vendored offline rebuild deviation.",
    });
  });
});
