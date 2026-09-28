import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handoffPath } from "../src/modules/builder/handoff.js";
import { dockerFinalSandboxOptions, dockerResourceLimits } from "../src/modules/builder/run-cli.config.js";
import { prefetchCargoDependencies } from "../src/modules/builder/sandbox-runtime.js";
import type { RunCliInput } from "../src/modules/builder/run-cli.types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "modules", "builder");

const SHARED_CACHE_TARGETS = [
  "/root/.cargo",
  "/usr/local/cargo",
  "/root/.rustup",
  "/usr/local/rustup",
  "/var/cache",
  "~/.cargo",
  "~/.rustup",
];

const ALLOWED_MOUNT_TARGETS = ["/source:ro", "/vendor", "/vendor:ro", "/out"];

function mountValues(command: string[]): string[] {
  const mounts: string[] = [];
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] === "-v" || command[i] === "--volume" || command[i] === "--mount") {
      mounts.push(command[i + 1]);
    }
  }
  return mounts;
}

describe("TB4 — the acquisition container shares nothing with any other job", () => {
  it("is a fresh `--rm` container on a read-only rootfs with per-container tmpfs", async () => {
    const { command } = await runPrefetch();

    expect(command).toContain("--rm");
    expect(command).toContain("--read-only");
    expect(command.filter((arg) => arg === "--tmpfs")).toHaveLength(2);
    expect(command).toContain("--user");
  });

  it("mounts exactly the per-job bind mounts, and no shared cache or named volume", async () => {
    const { command, sourceRoot, vendorDir, outDir } = await runPrefetch();
    const mounts = mountValues(command);

    expect(mounts).toEqual([
      `${sourceRoot}:/source:ro`,
      `${vendorDir}:/vendor`,
      `${outDir}:/out`,
    ]);

    expect(command.some((arg) => arg === "--mount" || arg === "--volume")).toBe(false);

    for (const value of mounts) {
      expect(value.split(":")[0].startsWith("/")).toBe(true);
    }

    for (const target of SHARED_CACHE_TARGETS) {
      expect(command).not.toContain(target);
    }
  });

  it("keeps CARGO_HOME per-job, container-relative — not a shared host registry", async () => {
    const { command } = await runPrefetch();

    expect(command).toContain("CARGO_HOME=/out/cargo-home");
    expect(command.some((arg) => arg.startsWith("CARGO_HOME=") && arg.includes("/root"))).toBe(false);
  });
});

describe("TB4 — the materialiser/runner handoff is namespaced per job", () => {
  it("gives two jobs distinct handoff paths, so neither can read the other's source", () => {
    const a = handoffPath("/tmp", "job-a");
    const b = handoffPath("/tmp", "job-b");

    expect(a).not.toBe(b);
    expect(a).toContain("job-a");
    expect(b).toContain("job-b");
    expect(a).toContain(join("scvs-handoff", "job-a"));
  });
});

describe("TB4 — the build stage's per-job directories are derived from a fresh temp dir", () => {
  it("creates the output directory per job, and derives vendor/cargo-home from it", () => {
    const runCli = readFileSync(join(SRC, "run-cli.ts"), "utf8");
    expect(runCli).toContain('mkdtemp(join(tmpdir(), "scvs-build-"))');
    expect(runCli).toContain('join(outDir, "vendor")');
    expect(runCli).toContain('join(outDir, "cargo-home")');
  });

  it("names no shared cache mount in either docker command assembly", () => {
    const runCli = readFileSync(join(SRC, "run-cli.ts"), "utf8");
    const runtime = readFileSync(join(SRC, "sandbox-runtime.ts"), "utf8");

    for (const target of SHARED_CACHE_TARGETS) {
      expect(runCli).not.toContain(target);
      expect(runtime).not.toContain(target);
    }
    for (const source of [runCli, runtime]) {
      expect(source).not.toMatch(/--mount\b/);
      expect(source).not.toMatch(/--volume\b/);
    }
  });
});

async function runPrefetch(): Promise<{
  command: string[];
  sourceRoot: string;
  vendorDir: string;
  outDir: string;
}> {
  const outDir = await mkdtemp(join(tmpdir(), "scvs-fresh-out-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "scvs-fresh-src-"));
  const vendorDir = join(outDir, "vendor");

  const input = {
    mode: "build",
    target: { network: "testnet", contract_id: "C".repeat(56) },
    build: {
      image: "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64),
      workspace_path: ".",
      target: "wasm32v1-none",
      bldarg: [],
      bldopt: [],
    },
    source: {
      mode: "hosted_tarball",
      visibility: "public",
      retained_after_verification: false,
      workspace_path: sourceRoot,
      local_path: sourceRoot,
    },
    // 1 ms: the docker run cannot succeed or hang the suite, and the assembled command is returned either way.
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
  });

  return { command: result.command, sourceRoot, vendorDir, outDir };
}
