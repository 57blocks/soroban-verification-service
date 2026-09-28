import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";

const runCommand = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("@scvs/core/process", () => ({
  runCommand,
  sha256File: jest.fn(),
  byteSize: jest.fn(),
}));

// Dynamic import: a static one would load the real module, and its real `@scvs/core/process`, before the mock.
const { detectRustToolchainFile, resolveTrustedToolchain } = await import(
  "../src/modules/builder/toolchain.js"
);

const result = (over: Record<string, unknown>) => ({
  command: ["docker"],
  exit_code: 0,
  stdout: "",
  stderr: "",
  timed_out: false,
  ...over,
});

beforeEach(() => runCommand.mockReset());

describe("resolveTrustedToolchain", () => {
  it("pins the image's active toolchain", async () => {
    runCommand.mockResolvedValue(result({ stdout: "1.85.0-x86_64-unknown-linux-gnu (default)\n" }));

    const resolved = await resolveTrustedToolchain("img@sha256:x", await emptySource());

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.toolchain).toBe("1.85.0-x86_64-unknown-linux-gnu");
  });

  it.each([
    ["a timeout", { exit_code: null, timed_out: true }],
    ["a spawn failure", { exit_code: null, error: "spawn ENOENT" }],
    ["a docker pull failure", { exit_code: 125, stderr: "Error response from daemon: manifest unknown" }],
    ["a rate-limited pull", { exit_code: 125, stderr: "toomanyrequests" }],
    ["an unexplained non-zero exit", { exit_code: 1, stderr: "" }],
  ])("fails closed on %s, even with no toolchain file in the source", async (_name, over) => {
    runCommand.mockResolvedValue(result(over));

    const resolved = await resolveTrustedToolchain("img@sha256:x", await emptySource());

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("toolchain_probe_failed");
  });

  it.each([
    ["exit 127", { exit_code: 127, stderr: "" }],
    ["a not-found message", { exit_code: 1, stderr: "exec: \"rustup\": executable file not found in $PATH" }],
  ])("proceeds unpinned when the probe reports no rustup (%s)", async (_name, over) => {
    runCommand.mockResolvedValue(result(over));

    const resolved = await resolveTrustedToolchain("img@sha256:x", await emptySource());

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.toolchain).toBeUndefined();
  });

  it("fails when the source pins a toolchain and the image has no rustup", async () => {
    runCommand.mockResolvedValue(result({ exit_code: 127 }));

    const resolved = await resolveTrustedToolchain("img@sha256:x", await sourceWithToolchainFile());

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toBe("toolchain_pin_unavailable");
      expect(resolved.sourceToolchainFile).toBe("rust-toolchain.toml");
    }
  });

  it("pins the image's toolchain regardless of what the source asks for", async () => {
    runCommand.mockResolvedValue(result({ stdout: "1.85.0\n" }));

    const resolved = await resolveTrustedToolchain("img@sha256:x", await sourceWithToolchainFile());

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.toolchain).toBe("1.85.0");
      expect(resolved.sourceToolchainFile).toBe("rust-toolchain.toml");
    }
  });

  it("budgets the probe like the prefetch, not like a health check", async () => {
    runCommand.mockResolvedValue(result({ stdout: "1.85.0\n" }));

    await resolveTrustedToolchain("img@sha256:x", await emptySource(), {
      dependencyPrefetchTimeoutMs: 600_000,
      dockerCheckTimeoutMs: 10_000,
    });

    const [, options] = runCommand.mock.calls[0] as [string[], { timeout_ms: number }];
    expect(options.timeout_ms).toBe(600_000);
  });
});

describe("detectRustToolchainFile", () => {
  it("finds rust-toolchain.toml", async () => {
    expect(await detectRustToolchainFile(await sourceWithToolchainFile())).toBe("rust-toolchain.toml");
  });

  it("returns undefined when the source pins nothing", async () => {
    expect(await detectRustToolchainFile(await emptySource())).toBeUndefined();
  });
});

async function emptySource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scvs-toolchain-"));
  await mkdir(root, { recursive: true });
  return root;
}

async function sourceWithToolchainFile(): Promise<string> {
  const root = await emptySource();
  await writeFile(join(root, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.70.0\"\n");
  return root;
}
