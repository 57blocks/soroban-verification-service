import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { runCli } from "../src/modules/builder/run-cli.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"d".repeat(64)}`;
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const WASM_SHA256 = createHash("sha256").update(WASM).digest("hex");
const VICTIM_CONTENTS = "the runner must never write through a link the sandbox planted\n";

// Stands in for the host daemon. In the prefetch stage it does what code run by `cargo vendor` can do to
// the host paths behind its writable mounts; in the build stage it records what `/vendor` resolves to.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "ps") process.exit(0);
const entrypoint = args.includes("--entrypoint") ? args[args.indexOf("--entrypoint") + 1] : undefined;
if (entrypoint === "rustup") { console.log("stable"); process.exit(0); }
const mounts = args.flatMap((arg, i) => {
  if (args[i - 1] !== "-v") return [];
  const [source, target, mode] = arg.split(":");
  return [{ source, target, readOnly: mode === "ro" }];
});
const stage = entrypoint === "cargo" ? "prefetch" : args.includes("none") ? "build" : "other";
const log = (entry) => fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(entry) + "\\n");
const resolved = (source) => { try { return fs.realpathSync(source); } catch { return null; } };
log({ stage, mounts: mounts.map((m) => ({ ...m, resolved: resolved(m.source) })) });

if (stage === "prefetch") {
  const vendor = mounts.find((m) => m.target === "/vendor").source;
  for (const m of mounts.filter((m) => !m.readOnly)) {
    // A writable mount that holds the vendor directory lets the stage swap it for a symlink.
    if (path.dirname(vendor) === m.source) {
      fs.renameSync(vendor, vendor + ".orig");
      fs.symlinkSync(process.env.FAKE_HOST_SECRET_DIR, vendor);
    }
    // Plant a link where the runner later writes the vendored-sources config.
    const cargoHome = m.target === "/out/cargo-home" ? m.source : m.target === "/out" ? path.join(m.source, "cargo-home") : null;
    if (cargoHome) {
      fs.mkdirSync(cargoHome, { recursive: true });
      fs.symlinkSync(process.env.FAKE_VICTIM_FILE, path.join(cargoHome, "config.toml"));
    }
  }
  if (process.env.FAKE_SWAP_VENDOR_FROM_OUTSIDE && !fs.lstatSync(vendor).isSymbolicLink()) {
    // Reach the stage should never have: the vendor directory's own parent.
    fs.renameSync(vendor, vendor + ".orig");
    fs.symlinkSync(process.env.FAKE_HOST_SECRET_DIR, vendor);
  }
  process.exit(0);
}

if (stage === "build") {
  const artifact = mounts.find((m) => m.target === "/artifact").source;
  fs.writeFileSync(path.join(artifact, "c.wasm"), Buffer.from(${JSON.stringify([...WASM])}));
  console.log("Wasm File: /artifact/c.wasm");
  console.log("Wasm Hash: ${WASM_SHA256}");
}
process.exit(0);
`;

type LoggedMount = { source: string; target: string; readOnly: boolean; resolved: string | null };
type LoggedRun = { stage: "prefetch" | "build" | "other"; mounts: LoggedMount[] };

function strictlyInside(parent: string, child: string): boolean {
  const below = relative(parent, child);
  return below !== "" && !below.startsWith("..") && !isAbsolute(below);
}

describe("prefetch cannot redirect a later bind mount to a host path", () => {
  const saved = { ...process.env };
  let fakeBin: string;
  let secretDir: string;
  let victimFile: string;
  let sourceRoot: string;
  let workDirs: string[];

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "scvs-swap-docker-"));
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER);
    await chmod(join(fakeBin, "docker"), 0o755);
    secretDir = await realpath(await mkdtemp(join(tmpdir(), "scvs-swap-host-")));
    await writeFile(join(secretDir, "instance-credentials"), "host-only");
    victimFile = join(secretDir, "victim.json");
    await writeFile(victimFile, VICTIM_CONTENTS);
    sourceRoot = join(await mkdtemp(join(tmpdir(), "scvs-swap-src-")), "source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.0.0"\n');
    workDirs = [];

    process.env.PATH = `${fakeBin}:${saved.PATH}`;
    process.env.FAKE_DOCKER_LOG = join(fakeBin, "runs.log");
    process.env.FAKE_HOST_SECRET_DIR = secretDir;
    process.env.FAKE_VICTIM_FILE = victimFile;
  });

  afterEach(async () => {
    process.env = { ...saved };
    for (const dir of [fakeBin, secretDir, join(sourceRoot, ".."), ...workDirs]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function rebuild() {
    return runCli({
      mode: "build",
      target: { network: "testnet", wasm_hash: "a".repeat(64) },
      build: { image: IMAGE, workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt: [] },
      source: { mode: "hosted_tarball", visibility: "public", workspace_path: sourceRoot, retained_after_verification: false },
      config: { cliTimeoutMs: 10_000 },
      workDirs,
    });
  }

  async function runs(): Promise<LoggedRun[]> {
    const log = await readFile(process.env.FAKE_DOCKER_LOG!, "utf8").catch(() => "");
    return log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LoggedRun);
  }

  it("gives the prefetch stage no writable mount that contains a later bind source", async () => {
    const result = await rebuild();
    const logged = await runs();
    const prefetch = logged.find((run) => run.stage === "prefetch");
    const build = logged.find((run) => run.stage === "build");

    expect(prefetch).toBeDefined();
    expect(build).toBeDefined();
    for (const writable of prefetch!.mounts.filter((m) => !m.readOnly)) {
      for (const bound of build!.mounts) {
        expect(strictlyInside(writable.source, bound.source)).toBe(false);
      }
    }
    for (const bound of build!.mounts) {
      expect(bound.resolved).toBe(bound.source);
      expect(strictlyInside(secretDir, bound.resolved!) || bound.resolved === secretDir).toBe(false);
    }
    expect(result.outcome).toBe("built");
  });

  it("fails closed, and never starts the build, when the vendor directory is swapped for a symlink", async () => {
    process.env.FAKE_SWAP_VENDOR_FROM_OUTSIDE = "1";

    const result = await rebuild();
    const logged = await runs();

    expect(logged.some((run) => run.stage === "prefetch")).toBe(true);
    expect(logged.some((run) => run.stage === "build")).toBe(false);
    expect(result.outcome).toBe("cli_failure");
    expect(result.reason).toBe("sandbox_mount_source_unsafe");
    expect(String(result.diagnostics?.detail)).toMatch(/symbolic link/);
  });

  it("never writes the vendored-sources config through a link the prefetch stage planted", async () => {
    await rebuild();

    expect(await readFile(victimFile, "utf8")).toBe(VICTIM_CONTENTS);
    const jobDir = workDirs.find((dir) => /scvs-build-/.test(dir))!;
    const written = await lstat(join(jobDir, "out", "cargo-home", "config.toml"));
    expect(written.isSymbolicLink()).toBe(false);
    expect(written.isFile()).toBe(true);
  });
});
