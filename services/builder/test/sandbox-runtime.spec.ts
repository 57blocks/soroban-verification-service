import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prefetchCargoDependencies } from "../src/modules/builder/sandbox-runtime.js";
import { dockerFinalSandboxOptions, dockerResourceLimits } from "../src/modules/builder/run-cli.config.js";
import type { RunCliInput } from "../src/modules/builder/run-cli.types.js";

/**
 * `cargo vendor` runs `build.rs` from submitted source with network access, one stage before the container we
 * harden properly.
 */
describe("prefetchCargoDependencies — the acquisition container's shape", () => {
  it("carries the same sandbox construction as the build container", async () => {
    const { command } = await runPrefetch();

    // From resourceLimits, which the stage already had.
    expect(command).toContain("--cap-drop");
    expect(command).toContain("ALL");
    expect(command).toContain("--security-opt");
    expect(command).toContain("no-new-privileges");
    expect(command).toContain("--pids-limit");
    expect(command).toContain("--cpus");
    expect(command).toContain("--memory");

    // From finalSandbox, which it did not: it ran as root on a writable rootfs.
    expect(command).toContain("--read-only");
    expect(command).toContain("--user");
    expect(command.filter((arg) => arg === "--tmpfs")).toHaveLength(2);

    // The user must be the process's own, not a fixed id.
    const user = command[command.indexOf("--user") + 1];
    expect(user).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
    expect(user).not.toBe("0:0");
  });

  it("keeps the writable mounts the stage exists to produce", async () => {
    const { command, vendorDir, outDir } = await runPrefetch();

    // --read-only bounds the rootfs around these; it does not replace them.
    expect(command).toContain(`${vendorDir}:/vendor`);
    expect(command).toContain(`${outDir}:/out`);
    // The source stays read-only, as it is on the build stage.
    expect(command.some((arg) => arg.endsWith(":/source:ro"))).toBe(true);
  });

  /** BE3: the stage is driven only by trusted image-class configuration. */
  it("pins RUSTUP_TOOLCHAIN when one was resolved", async () => {
    const { command } = await runPrefetch("1.85.0");

    expect(command).toContain("RUSTUP_TOOLCHAIN=1.85.0");
  });

  it("passes no toolchain env when none could be resolved", async () => {
    const { command } = await runPrefetch(undefined);

    expect(command.some((arg) => arg.startsWith("RUSTUP_TOOLCHAIN="))).toBe(false);
  });
});

async function runPrefetch(rustupToolchain?: string): Promise<{
  command: string[];
  vendorDir: string;
  outDir: string;
}> {
  const outDir = await mkdtemp(join(tmpdir(), "scvs-prefetch-out-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-prefetch-src-"));
  const vendorDir = join(outDir, "vendor");

  const input = {
    mode: "build",
    target: { network: "testnet", contract_id: "C".repeat(56) },
    build: { image: "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64), workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt: [] },
    source: { mode: "hosted_tarball", visibility: "public", retained_after_verification: false, workspace_path: sourceRoot, local_path: sourceRoot },
    // A timeout short enough that the `docker run` this issues cannot succeed or hang the suite: the assertion
    // is on the command that was assembled, which is returned either way.
    config: { dependencyPrefetchTimeoutMs: 1, dockerCheckTimeoutMs: 1 },
  } as unknown as RunCliInput;

  const result = await prefetchCargoDependencies({
    input,
    sourceRoot,
    outDir,
    cargoHomeDir: join(outDir, "cargo-home"),
    containerManifestPath: "/source/Cargo.toml",
    resourceLimits: dockerResourceLimits(input.config),
    finalSandbox: dockerFinalSandboxOptions(input.config),
    vendorDir,
    egressPolicy: { ok: true, allowed_hosts: ["crates.io"] },
    ...(rustupToolchain ? { rustupToolchain } : {}),
  });

  return { command: result.command, vendorDir, outDir };
}
