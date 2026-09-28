import { dockerBuildDiagnostics, dockerUnavailableDiagnostics } from "../src/modules/builder/diagnostics.js";
import { dockerFinalSandboxOptions, dockerResourceLimits } from "../src/modules/builder/run-cli.config.js";
import type { CommandResult } from "@scvs/core/process";
import type { RunCliInput } from "../src/modules/builder/run-cli.types.js";

const command = (over: Partial<CommandResult> = {}): CommandResult =>
  ({ exit_code: 0, stdout: "", stderr: "", timed_out: false, ...over }) as CommandResult;

const runCliInput = {
  mode: "build",
  target: { network: "testnet", contract_id: "C".repeat(56) },
  build: { image: `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`, workspace_path: "." },
} as unknown as RunCliInput;

const buildDiagnostics = () =>
  dockerBuildDiagnostics({
    input: runCliInput,
    build: command({ exit_code: 0 }),
    command: ["docker", "run", "--rm"],
    commandSummary: "docker run --rm",
    sourceRoot: "/tmp/src",
    outDir: "/tmp/out",
    manifestPath: "/tmp/src/Cargo.toml",
    containerManifestPath: "/source/Cargo.toml",
    prefetch: { ok: true, result: command(), command: [], commandSummary: "" },
    cargoHomeDir: "/tmp/out/cargo-home",
    vendorDir: "/tmp/out/vendor",
    resourceLimits: dockerResourceLimits(),
    finalSandbox: dockerFinalSandboxOptions(),
    egressPolicy: { allowed_hosts: ["static.crates.io"] } as never,
    network: "none",
    cargoConfigPath: "/tmp/out/cargo-home/config.toml",
    replayedBldopts: [],
    unparsableBldopts: [],
  });

describe("a failure on the build path is never an infrastructure failure", () => {
  it("carries no docker_error, which is what keeps it out of internal_error", () => {
    expect(buildDiagnostics()).not.toHaveProperty("docker_error");
  });

  it("reports docker as available, unlike the one path that does set docker_error", () => {
    expect(buildDiagnostics().docker_available).toBe(true);

    const unavailable = dockerUnavailableDiagnostics(
      runCliInput,
      command({ exit_code: 1, stderr: "Cannot connect to the Docker daemon" }),
      "/source/Cargo.toml",
    );
    expect(unavailable.docker_available).toBe(false);
    expect(unavailable.docker_error).toContain("Cannot connect to the Docker daemon");
  });
});
