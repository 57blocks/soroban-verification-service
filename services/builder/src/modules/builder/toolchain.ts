// Toolchain pinning and the vendored-offline cargo config.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process-utils.js";
import type { CommandResult } from "./process-utils.js";
import { dependencyPrefetchTimeoutMs } from "./run-cli.config.js";
import type { RunCliRuntimeConfig } from "./run-cli.types.js";

/**
 * Cargo config files a project can ship, in cargo's own precedence order (`config.toml` wins when both are
 * present).
 */
export const SOURCE_CARGO_CONFIG_FILES = [join(".cargo", "config.toml"), join(".cargo", "config")];

/**
 * Write the vendored-sources + offline redirect to `$CARGO_HOME/config.toml` and return the in-container path
 * (for diagnostics).
 */
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

/** Whether the submitted source defines its own `[source.*]` cargo configuration. */
export async function detectSourceCargoSourceOverride(sourceRoot: string): Promise<string | undefined> {
  for (const relativePath of SOURCE_CARGO_CONFIG_FILES) {
    const text = await readFile(join(sourceRoot, relativePath), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    if (/^[^\S\n]*\[source\b/m.test(text)) return relativePath;
    // A bare `replace-with` outside a `[source.*]` header is not valid cargo config, but a dotted-key form
    // (`source.crates-io.replace-with = …`) is, and would have the same effect.
    if (/^[^\S\n]*source\s*\.[^\n=]*replace-with\s*=/m.test(text)) return relativePath;
  }
  return undefined;
}

/** Toolchain files rustup honours, in the order it looks for them. */
export const RUST_TOOLCHAIN_FILES = ["rust-toolchain.toml", "rust-toolchain"];

/** Whether the submitted source pins its own Rust toolchain. */
export async function detectRustToolchainFile(sourceRoot: string): Promise<string | undefined> {
  for (const name of RUST_TOOLCHAIN_FILES) {
    const info = await stat(join(sourceRoot, name)).catch(() => undefined);
    if (info?.isFile()) return name;
  }
  return undefined;
}

/**
 * Probe the digest-pinned image for the toolchain rustup would use by default, so the rebuild can pin it via
 * `RUSTUP_TOOLCHAIN`.
 */
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
  | { ok: false; reason: string; detail: string; probe: CommandResult; sourceToolchainFile?: string };

/** Today that is the digest-pinned image's own active toolchain, probed. */
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

  // The image reports no active toolchain and the source names none, so there is no rustup for anything to
  // hijack.
  return { ok: true, probe: probe.result, ...withFile };
}

/**
 * Whether the probe ran to completion and established that the image has no usable rustup, as opposed to
 * failing for a reason that leaves the question open.
 */
function imageHasNoRustup(result: CommandResult): boolean {
  if (result.timed_out || result.exit_code === null) return false;
  if (result.exit_code === 127) return true;
  const output = `${result.stderr}\n${result.error ?? ""}`;
  return /executable file not found|no such file or directory/i.test(output);
}
