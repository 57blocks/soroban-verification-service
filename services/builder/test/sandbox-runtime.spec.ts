import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prefetchCargoDependencies } from "../src/modules/builder/sandbox-runtime.js";
import { dockerFinalSandboxOptions, dockerResourceLimits } from "../src/modules/builder/run-cli.config.js";
import type { RunCliInput } from "../src/modules/builder/run-cli.types.js";

describe("prefetchCargoDependencies — the acquisition container's shape", () => {
  it("carries the same sandbox construction as the build container", async () => {
    const { command } = await runPrefetch();

    expect(command).toContain("--cap-drop");
    expect(command).toContain("ALL");
    expect(command).toContain("--security-opt");
    expect(command).toContain("no-new-privileges");
    expect(command).toContain("--pids-limit");
    expect(command).toContain("--cpus");
    expect(command).toContain("--memory");

    expect(command).toContain("--read-only");
    expect(command).toContain("--user");
    expect(command.filter((arg) => arg === "--tmpfs")).toHaveLength(2);

    const user = command[command.indexOf("--user") + 1];
    expect(user).toBe("65532:65532");
    expect(user).not.toBe(`${process.getuid?.()}:${process.getgid?.()}`);
  });

  it("keeps the writable mounts the stage exists to produce, and never their parent", async () => {
    const { command, vendorDir, cargoHomeDir, jobDir } = await runPrefetch();

    expect(command).toContain(`type=bind,source=${vendorDir},target=/vendor,bind-recursive=disabled`);
    expect(command).toContain(`type=bind,source=${cargoHomeDir},target=/out/cargo-home,bind-recursive=disabled`);
    expect(command.some((arg) => arg.includes(",target=/source,readonly,"))).toBe(true);
    expect(command.some((arg) => arg.includes(`source=${jobDir},`))).toBe(false);
  });

  it("runs outside /source, so cargo never loads the submitted .cargo/config", async () => {
    const { command } = await runPrefetch();

    expect(command[command.indexOf("-w") + 1]).toBe("/");
  });

  it("pins RUSTUP_TOOLCHAIN when one was resolved", async () => {
    const { command } = await runPrefetch("1.85.0");

    expect(command).toContain("RUSTUP_TOOLCHAIN=1.85.0");
  });

  it("passes no toolchain env when none could be resolved", async () => {
    const { command } = await runPrefetch(undefined);

    expect(command.some((arg) => arg.startsWith("RUSTUP_TOOLCHAIN="))).toBe(false);
  });

  it("joins the gateway's prefetch network and reaches out only through its proxy", async () => {
    const egress = { network: "scvs-prefetch-0a1b2c3d4e5f", proxy: "http://scvs-egress-proxy:3128" };
    const { command } = await runPrefetch(undefined, egress);

    expect(command.filter((arg) => arg === "--network")).toHaveLength(1);
    expect(command[command.indexOf("--network") + 1]).toBe(egress.network);
    for (const name of ["CARGO_HTTP_PROXY", "HTTPS_PROXY", "https_proxy"]) {
      expect(command).toContain(`${name}=${egress.proxy}`);
    }
    // Before the image: everything after it is cargo's own arguments.
    expect(command.indexOf("--network")).toBeLessThan(command.indexOf("vendor"));
  });

  it("without the gateway, takes Docker's default network and no proxy", async () => {
    const { command } = await runPrefetch(undefined);

    expect(command).not.toContain("--network");
    expect(command.some((arg) => /PROXY=/i.test(arg))).toBe(false);
  });
});

async function runPrefetch(rustupToolchain?: string, egress?: { network: string; proxy: string }): Promise<{
  command: string[];
  vendorDir: string;
  cargoHomeDir: string;
  jobDir: string;
}> {
  const jobDir = await mkdtemp(join(tmpdir(), "scvs-prefetch-job-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-prefetch-src-"));
  const vendorDir = join(jobDir, "vendor");
  const cargoHomeDir = join(jobDir, "out", "cargo-home");

  const input = {
    mode: "build",
    target: { network: "testnet", contract_id: "C".repeat(56) },
    build: { image: "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64), workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt: [] },
    source: { mode: "hosted_tarball", visibility: "public", retained_after_verification: false, workspace_path: sourceRoot, local_path: sourceRoot },
    // 1 ms: the docker run cannot succeed or hang the suite, and the assembled command is returned either way.
    config: { dependencyPrefetchTimeoutMs: 1, dockerCheckTimeoutMs: 1 },
  } as unknown as RunCliInput;

  const result = await prefetchCargoDependencies({
    input,
    sourceRoot,
    cargoHomeDir,
    containerManifestPath: "/source/Cargo.toml",
    resourceLimits: dockerResourceLimits(input.config),
    finalSandbox: dockerFinalSandboxOptions(input.config),
    vendorDir,
    egressPolicy: { ok: true, allowed_hosts: ["crates.io"] },
    ...(rustupToolchain ? { rustupToolchain } : {}),
    cidFile: join(jobDir, "prefetch.cid"),
    ...(egress ? { egress } : {}),
  });

  return { command: result.command, vendorDir, cargoHomeDir, jobDir };
}
