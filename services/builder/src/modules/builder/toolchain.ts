import type { RebuildErrorCode } from "@scvs/core";

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "@scvs/core/process";
import type { CommandResult } from "@scvs/core/process";
import { dependencyPrefetchTimeoutMs } from "./run-cli.config.js";
import type { RunCliRuntimeConfig } from "./run-cli.types.js";

export const SOURCE_CARGO_CONFIG_FILES = [join(".cargo", "config.toml"), join(".cargo", "config")];

export async function writeVendorCargoConfig(cargoHomeDir: string, vendorDir: string): Promise<string> {
  await mkdir(cargoHomeDir, { recursive: true });
  await writeFile(
    join(cargoHomeDir, "config.toml"),
    [
      "[source.crates-io]",
      "replace-with = \"vendored-sources\"",
      "",
      "[source.vendored-sources]",
      `directory = "${vendorDir}"`,
      "",
      "[net]",
      "offline = true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return "/out/cargo-home/config.toml";
}

export async function detectSourceCargoSourceOverride(sourceRoot: string): Promise<string | undefined> {
  for (const relativePath of SOURCE_CARGO_CONFIG_FILES) {
    const text = await readFile(join(sourceRoot, relativePath), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    if (/^[^\S\n]*\[source\b/m.test(text)) return relativePath;
    // Also the dotted-key form (`source.crates-io.replace-with = …`), which has the same effect.
    if (/^[^\S\n]*source\s*\.[^\n=]*replace-with\s*=/m.test(text)) return relativePath;
  }
  return undefined;
}

export const RUST_TOOLCHAIN_FILES = ["rust-toolchain.toml", "rust-toolchain"];

export async function detectRustToolchainFile(sourceRoot: string): Promise<string | undefined> {
  for (const name of RUST_TOOLCHAIN_FILES) {
    const info = await stat(join(sourceRoot, name)).catch(() => undefined);
    if (info?.isFile()) return name;
  }
  return undefined;
}

export async function probeActiveToolchain(
  image: string,
  config?: RunCliRuntimeConfig,
): Promise<{ toolchain?: string; result: CommandResult }> {
  const result = await runCommand(
    ["docker", "run", "--rm", "--entrypoint", "rustup", image, "show", "active-toolchain"],
    { timeout_ms: dependencyPrefetchTimeoutMs(config) },
  );
  if (result.exit_code !== 0) return { result };
  const toolchain = result.stdout.trim().split(/\s+/)[0];
  return { ...(toolchain ? { toolchain } : {}), result };
}

export type TrustedToolchain =
  | { ok: true; toolchain?: string; probe: CommandResult; sourceToolchainFile?: string }
  | { ok: false; reason: RebuildErrorCode; detail: string; probe: CommandResult; sourceToolchainFile?: string };

export async function resolveTrustedToolchain(
  image: string,
  sourceRoot: string,
  config?: RunCliRuntimeConfig,
): Promise<TrustedToolchain> {
  const sourceToolchainFile = await detectRustToolchainFile(sourceRoot);
  const probe = await probeActiveToolchain(image, config);
  const withFile = sourceToolchainFile ? { sourceToolchainFile } : {};

  if (probe.toolchain) {
    return { ok: true, toolchain: probe.toolchain, probe: probe.result, ...withFile };
  }

  // Fail-closed by default: only a probe that ran and reported "no rustup here" is safe to proceed on.
  if (!imageHasNoRustup(probe.result)) {
    return {
      ok: false,
      reason: "toolchain_probe_failed",
      detail:
        "The build image's active toolchain could not be established " +
        `(exit ${probe.result.exit_code ?? "none"}${probe.result.timed_out ? ", timed out" : ""}), ` +
        "so the toolchain this rebuild would compile with is unknown. Refusing to build unpinned.",
      probe: probe.result,
      ...withFile,
    };
  }

  if (sourceToolchainFile) {
    return {
      ok: false,
      reason: "toolchain_pin_unavailable",
      detail:
        `The submitted source pins a toolchain via ${sourceToolchainFile}, but the build image's ` +
        "active toolchain could not be probed, so RUSTUP_TOOLCHAIN cannot be set. The rebuild " +
        "would compile with a toolchain the image digest does not determine.",
      probe: probe.result,
      ...withFile,
    };
  }

  return { ok: true, probe: probe.result, ...withFile };
}

function imageHasNoRustup(result: CommandResult): boolean {
  if (result.timed_out || result.exit_code === null) return false;
  if (result.exit_code === 127) return true;
  const output = `${result.stderr}\n${result.error ?? ""}`;
  return /executable file not found|no such file or directory/i.test(output);
}
