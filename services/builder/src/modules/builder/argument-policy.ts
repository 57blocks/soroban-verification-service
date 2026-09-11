import { CONTAINER_ARTIFACT_DIR, CONTAINER_OUT_DIR } from "./artifact-selection.js";
import { runCommand, type CommandResult } from "./process-utils.js";
import type { RunCliRuntimeConfig } from "./run-cli.types.js";
import { dockerCheckTimeoutMs } from "./run-cli.config.js";

export type AddedArgument = {
  flag: string;
  stage: "build-command" | "container-env" | "acquisition";
  lever: string;
  addressedBy: { spelling: string; onContradiction: "suppress" | "conflict" }[];
  argv: string[];
  rule: "BE11";
  justification: string;
  probe?: { subcommand: string[]; flag: string };
  byteNeutralFixture: string;
};

export const ADDED_ARGUMENTS: readonly AddedArgument[] = [
  {
    flag: "--locked",
    stage: "acquisition",
    lever: "dependency-locking",
    addressedBy: [{ spelling: "--locked", onContradiction: "suppress" }],
    argv: ["--locked"],
    rule: "BE11",
    justification:
      "Lock enforcement belongs to dependency acquisition, where cargo vendor --locked fixes the dependency set before the offline build. The rebuild command never adds --locked on its own.",
    byteNeutralFixture: "be7-vendored-offline-current",
  },
  {
    flag: "--manifest-path",
    stage: "build-command",
    lever: "manifest-path",
    addressedBy: [{ spelling: "--manifest-path", onContradiction: "suppress" }],
    argv: ["--manifest-path"],
    rule: "BE11",
    justification:
      "The source archive can place Cargo.toml below the source root; the rebuild must pass the normalized in-container manifest path instead of relying on the container working directory.",
    probe: { subcommand: ["contract", "build", "--help"], flag: "--manifest-path" },
    byteNeutralFixture: "cli-legacy-single-package-current",
  },
  {
    flag: "--out-dir",
    stage: "build-command",
    lever: "output-directory",
    addressedBy: [{ spelling: "--out-dir", onContradiction: "suppress" }],
    argv: ["--out-dir", CONTAINER_ARTIFACT_DIR],
    rule: "BE11",
    justification:
      "The rebuilt artifact is the sole Wasm in a mount that carries nothing else, so the build command must direct generated Wasm there explicitly. A recorded spelling of this flag is dropped rather than replayed: the artifact has to land where the builder is looking.",
    probe: { subcommand: ["contract", "build", "--help"], flag: "--out-dir" },
    byteNeutralFixture: "cli-legacy-single-package-current",
  },
  {
    flag: "CARGO_TARGET_DIR",
    stage: "container-env",
    lever: "target-directory",
    addressedBy: [
      { spelling: "--target-dir", onContradiction: "suppress" },
      { spelling: "CARGO_TARGET_DIR", onContradiction: "suppress" },
    ],
    argv: [`CARGO_TARGET_DIR=${CONTAINER_OUT_DIR}/target`],
    rule: "BE11",
    justification:
      "A redirected target directory keeps compiler intermediates out of the read-only source mount. If the recipe records its own target directory, replay wins.",
    byteNeutralFixture: "be7-redirected-target-dir-current",
  },
  {
    flag: "TMPDIR",
    stage: "container-env",
    lever: "temporary-directory",
    addressedBy: [{ spelling: "TMPDIR", onContradiction: "suppress" }],
    argv: [`TMPDIR=${CONTAINER_OUT_DIR}/tmp`],
    rule: "BE11",
    justification:
      "Temporary files must be written to the output mount because the source tree is mounted read-only during the build.",
    byteNeutralFixture: "be7-readonly-source-mount-current",
  },
  {
    flag: "CARGO_HOME",
    stage: "container-env",
    lever: "cargo-home",
    addressedBy: [{ spelling: "CARGO_HOME", onContradiction: "suppress" }],
    argv: [`CARGO_HOME=${CONTAINER_OUT_DIR}/cargo-home`],
    rule: "BE11",
    justification:
      "Cargo configuration for the vendored source redirect is written outside the submitted source and supplied through CARGO_HOME.",
    byteNeutralFixture: "be7-vendored-offline-current",
  },
  {
    flag: "CARGO_NET_OFFLINE",
    stage: "container-env",
    lever: "offline-mode",
    addressedBy: [
      { spelling: "--offline", onContradiction: "conflict" },
      { spelling: "CARGO_NET_OFFLINE", onContradiction: "conflict" },
    ],
    argv: ["CARGO_NET_OFFLINE=true"],
    rule: "BE11",
    justification:
      "The build runs against the vendored dependency tree with network disabled; a recorded value may agree with offline mode, but it may not switch the deviation off.",
    byteNeutralFixture: "be7-vendored-offline-current",
  },
  {
    flag: "RUSTUP_TOOLCHAIN",
    stage: "container-env",
    lever: "rust-toolchain",
    addressedBy: [{ spelling: "RUSTUP_TOOLCHAIN", onContradiction: "suppress" }],
    argv: ["RUSTUP_TOOLCHAIN"],
    rule: "BE11",
    justification:
      "When the image's active Rust toolchain is known, the rebuild pins rustup to it so in-source toolchain files cannot make the image digest ambiguous.",
    byteNeutralFixture: "cli-legacy-single-package-current",
  },
];

export type ResolveAddedEnvironmentInput = {
  recordedEnv: string[];
  recordedBuildArgs: string[];
  cargoHome?: string;
  cargoNetOffline?: boolean;
  rustupToolchain?: string;
};

export type ResolveAddedEnvironmentResult =
  | { ok: true; env: string[]; skipped: { flag: string; reason: string }[] }
  | { ok: false; reason: "offline_mode_conflicts_with_deviation"; detail: string };

export function resolveAddedEnvironment(input: ResolveAddedEnvironmentInput): ResolveAddedEnvironmentResult {
  const skipped: { flag: string; reason: string }[] = [];
  const env: string[] = [];
  const recordedNames = new Set(input.recordedEnv.map(envName));

  if (!recordedNames.has("CARGO_TARGET_DIR") && !hasFlag(input.recordedBuildArgs, "--target-dir")) {
    env.push(`CARGO_TARGET_DIR=${CONTAINER_OUT_DIR}/target`);
  } else {
    skipped.push({ flag: "CARGO_TARGET_DIR", reason: "recorded recipe controls target-directory" });
  }

  if (!recordedNames.has("TMPDIR")) {
    env.push(`TMPDIR=${CONTAINER_OUT_DIR}/tmp`);
  } else {
    skipped.push({ flag: "TMPDIR", reason: "recorded recipe controls temporary-directory" });
  }

  if (input.cargoHome && !recordedNames.has("CARGO_HOME")) {
    env.push(`CARGO_HOME=${input.cargoHome}`);
  } else if (input.cargoHome) {
    skipped.push({ flag: "CARGO_HOME", reason: "recorded recipe controls cargo-home" });
  }

  if (input.cargoNetOffline) {
    const recordedOffline = input.recordedEnv.find((entry) => envName(entry) === "CARGO_NET_OFFLINE");
    if (recordedOffline !== undefined) {
      if (!envValueIsTrue(recordedOffline)) {
        return {
          ok: false,
          reason: "offline_mode_conflicts_with_deviation",
          detail:
            "The recorded bldopt sets CARGO_NET_OFFLINE to a value other than true, which would disable the vendored offline rebuild deviation.",
        };
      }
      skipped.push({ flag: "CARGO_NET_OFFLINE", reason: "recorded recipe already enables offline mode" });
    } else if (hasFlag(input.recordedBuildArgs, "--offline")) {
      skipped.push({ flag: "CARGO_NET_OFFLINE", reason: "recorded recipe already enables offline mode" });
    } else {
      env.push("CARGO_NET_OFFLINE=true");
    }
  }

  if (input.rustupToolchain && !recordedNames.has("RUSTUP_TOOLCHAIN")) {
    env.push(`RUSTUP_TOOLCHAIN=${input.rustupToolchain}`);
  } else if (input.rustupToolchain) {
    skipped.push({ flag: "RUSTUP_TOOLCHAIN", reason: "recorded recipe controls rust-toolchain" });
  }

  return { ok: true, env: [...env, ...input.recordedEnv], skipped };
}

/**
 * The image's `ENTRYPOINT` is not ours to trust. `bldarg` (`contract build`) only reaches the CLI if the
 * entrypoint *is* the CLI, and the official images now wrap it in a script that starts a session bus and
 * unlocks a keyring — neither of which can start under a uid with no `/etc/passwd` entry, so the `26.0.0`
 * oracle failed before the CLI ever ran. The prefetch and toolchain stages already name their own
 * entrypoint; this makes the rule uniform. Deliberately not a tunable: a configurable entrypoint is a way to
 * run a different binary inside the sandbox.
 */
export const CONTAINER_CLI_ENTRYPOINT = "stellar";

export type AssembleBuildCommandInput = {
  dockerArgs: string[];
  env: string[];
  image: string;
  leading: string[];
  forwarded: string[];
  manifestPath: string;
  packageName?: string;
};

export function assembleBuildCommand(input: AssembleBuildCommandInput): string[] {
  requireRegisteredBuildArgument("--manifest-path");
  requireRegisteredBuildArgument("--out-dir");
  return [
    ...input.dockerArgs,
    ...input.env.flatMap((env) => ["-e", env]),
    "--entrypoint",
    CONTAINER_CLI_ENTRYPOINT,
    input.image,
    ...input.leading,
    ...input.forwarded,
    "--manifest-path",
    input.manifestPath,
    ...(input.packageName ? ["--package", input.packageName] : []),
    "--out-dir",
    CONTAINER_ARTIFACT_DIR,
  ];
}

export type RejectedBuildArgument = {
  /** The flag as the CLI named it, with any `=value` stripped — see `flagName`. */
  flag: string;
  /** `recorded_bldopt` — the recipe asked for it and this image's CLI does not accept it. */
  origin: "recorded_bldopt" | "verifier_added";
};

/** Which argument the build image's CLI rejected, when it rejected one. */
export function rejectedBuildArgument(input: {
  stderr: string;
  argv: string[];
  replayedBldopts: string[];
}): RejectedBuildArgument | undefined {
  for (const pattern of REJECTED_ARGUMENT_PATTERNS) {
    for (const match of input.stderr.matchAll(pattern)) {
      const captured = match[1];
      if (!captured?.startsWith("-")) continue;

      const flag = flagName(captured);
      // Cross-check: we must actually have issued it. `argv` carries `--flag value` and `--flag=value` forms
      // both, so compare on the name.
      if (!input.argv.some((token) => flagName(token) === flag)) continue;

      return {
        flag,
        origin: input.replayedBldopts.some((token) => flagName(token) === flag)
          ? "recorded_bldopt"
          : "verifier_added",
      };
    }
  }
  return undefined;
}

/** clap's two rejection wordings. */
const REJECTED_ARGUMENT_PATTERNS: readonly RegExp[] = [
  // clap 4: error: unexpected argument '--locked' found
  /unexpected argument ['"]([^'"]+)['"]/gi,
  // clap 3: error: Found argument '--locked' which wasn't expected
  /found argument ['"]([^'"]+)['"] which wasn't expected/gi,
];

/**
 * A flag without its value. **Load-bearing for secrecy, not for tidiness.** The result reaches
 * `SandboxDiagnostics` and, through `rebuildFailureDetail`, the public job-status endpoint and SSE.
 */
function flagName(token: string): string {
  const at = token.indexOf("=");
  return at === -1 ? token : token.slice(0, at);
}

export async function probeBuildFlagSupport(
  image: string,
  subcommand: string[],
  flag: string,
  config?: RunCliRuntimeConfig,
): Promise<{ supported: boolean; result: CommandResult }> {
  const result = await runCommand(
    ["docker", "run", "--rm", image, ...subcommand],
    { timeout_ms: dockerCheckTimeoutMs(config) },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  return { supported: result.exit_code === 0 && output.includes(flag), result };
}

export async function resolveAddedArguments(
  image: string,
  recorded: string[],
  config?: RunCliRuntimeConfig,
): Promise<{ argv: string[]; skipped: { flag: string; reason: string }[] }> {
  const argv: string[] = [];
  const skipped: { flag: string; reason: string }[] = [];
  for (const entry of ADDED_ARGUMENTS.filter((item) => item.stage === "build-command")) {
    if (entry.addressedBy.some((address) => hasFlag(recorded, address.spelling))) {
      skipped.push({ flag: entry.flag, reason: "recorded recipe controls the same lever" });
      continue;
    }
    if (entry.probe) {
      const probe = await probeBuildFlagSupport(image, entry.probe.subcommand, entry.probe.flag, config);
      if (!probe.supported) {
        skipped.push({ flag: entry.flag, reason: "build image does not advertise flag support" });
        continue;
      }
    }
    argv.push(...entry.argv);
  }
  return { argv, skipped };
}

function requireRegisteredBuildArgument(flag: string): void {
  const entry = ADDED_ARGUMENTS.find((item) => item.flag === flag && item.stage === "build-command");
  if (!entry) throw new Error(`Build argument ${flag} is missing from ADDED_ARGUMENTS.`);
}

function envName(entry: string): string {
  return entry.split("=", 1)[0];
}

function envValueIsTrue(entry: string): boolean {
  return entry.slice(envName(entry).length + 1).toLowerCase() === "true";
}

function hasFlag(tokens: string[], flag: string): boolean {
  return tokens.some((token) => token === flag || token.startsWith(`${flag}=`));
}
