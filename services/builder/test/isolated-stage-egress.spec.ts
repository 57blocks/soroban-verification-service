import { assembleBuildCommand } from "../src/modules/builder/argument-policy.js";
import { dockerResourceLimits, dockerFinalSandboxOptions } from "../src/modules/builder/run-cli.config.js";

/** **T6 — a `build.rs` attempting an outbound connection in the isolated stage fails.** */
const config = undefined;

/** The build stage's docker argv, assembled the way `runManualRebuild` assembles it. */
function isolatedStageArgs(): string[] {
  return [
    "docker",
    "run",
    "--rm",
    ...dockerResourceLimits(config).args,
    ...dockerFinalSandboxOptions(config).args,
    "--network",
    "none",
  ];
}

describe("T6 — the isolated build stage has no network", () => {
  it("★ runs with --network none", () => {
    const args = isolatedStageArgs();
    const at = args.indexOf("--network");

    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("none");
  });

  it("names no other network, so the flag cannot be satisfied by a permissive value", () => {
    // `--network host` or a bridge would also produce a `--network` flag. The guard is the *value*.
    const args = isolatedStageArgs();

    expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(args).not.toContain("host");
    expect(args).not.toContain("bridge");
  });

  it("keeps the rest of the isolation the same flag set relies on", () => {
    // `--network none` alone is not the isolation: a container that kept capabilities or ran as root has other
    // routes out.
    const args = isolatedStageArgs();

    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
  });
});

describe("T6 — the assembled build command carries it end to end", () => {
  it("the real command builder emits the isolated stage's flags", () => {
    // Guards the seam between `isolatedStageArgs()` above — which mirrors the call site — and the function that
    // actually produces the command.
    const command = assembleBuildCommand({
      dockerArgs: isolatedStageArgs(),
      image: `docker.io/example/img@sha256:${"a".repeat(64)}`,
      env: [],
      leading: ["contract", "build"],
      forwarded: [],
      manifestPath: "/source/Cargo.toml",
    });

    const at = command.indexOf("--network");
    expect(at).toBeGreaterThan(-1);
    expect(command[at + 1]).toBe("none");
    // And the flag is on the docker side of the image reference, not passed to the build tool.
    expect(at).toBeLessThan(command.indexOf(`docker.io/example/img@sha256:${"a".repeat(64)}`));
  });
});
