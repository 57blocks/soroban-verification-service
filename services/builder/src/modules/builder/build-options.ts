import { isAbsolute, join } from "node:path";
import { splitShellWords, unescapeShellWord } from "@scvs/core";

export function shellSplit(value: string): string[] {
  const split = splitShellWords(value);
  return split.ok ? split.words : [];
}

export function leadingBuildArgs(bldarg: string[] | undefined): string[] {
  return bldarg?.length ? bldarg : ["contract", "build"];
}

export const BLDOPT_VALUE_FLAGS_HANDLED_ELSEWHERE = new Set(["--manifest-path", "--package", "-p", "--env", "--out-dir"]);

export const BLDOPT_INLINE_VALUE_FLAGS_HANDLED_ELSEWHERE = new Set(["--manifest-path", "--package", "-p", "--env", "--out-dir"]);

export type ReplayedBuildOptions = {
  forwarded: string[];
  reissued: string[];
  unparsable: { entry: string; reason: string }[];
};

export function replayableBuildOptions(options: string[] | undefined): ReplayedBuildOptions {
  const forwarded: string[] = [];
  const reissued: string[] = [];
  const unparsable: { entry: string; reason: string }[] = [];
  const tokens = unescapeBldoptEntries(options ?? [], unparsable);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (optionConsumesValue(token)) {
      reissued.push(token);
      if (tokens[index + 1] !== undefined) {
        reissued.push(tokens[index + 1]);
        index += 1;
      }
      continue;
    }
    const inlineFlag = token.match(/^(--?[A-Za-z0-9][A-Za-z0-9-]*)=/)?.[1];
    if (inlineFlag && BLDOPT_INLINE_VALUE_FLAGS_HANDLED_ELSEWHERE.has(inlineFlag)) {
      reissued.push(token);
      continue;
    }

    if (token === "--meta" || token === "--features" || token === "--profile") {
      const value = tokens[index + 1];
      if (value === undefined) {
        forwarded.push(token);
        continue;
      }
      forwarded.push(token, value);
      index += 1;
      continue;
    }
    forwarded.push(token);
  }

  return { forwarded, reissued, unparsable };
}

export function optionConsumesValue(token: string): boolean {
  return BLDOPT_VALUE_FLAGS_HANDLED_ELSEWHERE.has(token);
}

export function dockerEnvOptions(options: string[] | undefined): string[] {
  const env: string[] = [];
  const tokens = unescapeBldoptEntries(options ?? []);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--env" && tokens[index + 1]) {
      env.push(tokens[index + 1]);
      index += 1;
      continue;
    }
    const inline = token.match(/^--env=(.+)$/);
    if (inline) {
      env.push(inline[1]);
    }
  }
  return env;
}

export function withDefaultBuildEnv(
  env: string[],
  options: {
    cargoHome?: string;
    cargoNetOffline?: boolean;
    rustupToolchain?: string;
  } = {},
): string[] {
  const names = new Set(env.map((item) => item.split("=", 1)[0]));
  return [
    ...(names.has("CARGO_TARGET_DIR") ? [] : ["CARGO_TARGET_DIR=/out/target"]),
    ...(names.has("TMPDIR") ? [] : ["TMPDIR=/out/tmp"]),
    ...(options.cargoHome && !names.has("CARGO_HOME") ? [`CARGO_HOME=${options.cargoHome}`] : []),
    ...(options.cargoNetOffline && !names.has("CARGO_NET_OFFLINE") ? ["CARGO_NET_OFFLINE=true"] : []),
    ...(options.rustupToolchain && !names.has("RUSTUP_TOOLCHAIN")
      ? [`RUSTUP_TOOLCHAIN=${options.rustupToolchain}`]
      : []),
    ...env,
  ];
}

export function extractBuildPackage(bldopt?: string[]): string | undefined {
  const tokens = unescapeBldoptEntries(bldopt ?? []);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--package" || token === "-p") {
      return tokens[index + 1];
    }
    const inline = token.match(/^(?:--package|-p)=(.+)$/);
    if (inline) {
      return inline[1];
    }
  }
  return undefined;
}

function unescapeBldoptEntries(
  entries: string[],
  unparsable: { entry: string; reason: string }[] = [],
): string[] {
  const words: string[] = [];
  for (const entry of entries) {
    const parsed = unescapeShellWord(entry);
    if (parsed.ok) {
      words.push(parsed.word);
    } else {
      unparsable.push({ entry, reason: parsed.reason });
    }
  }
  return words;
}

export function resolveManifestPath(sourceRoot: string, workspacePath: string): string {
  const raw = workspacePath || ".";
  const candidate = isAbsolute(raw) ? raw : join(sourceRoot, raw);
  if (candidate.endsWith("Cargo.toml")) {
    return candidate;
  }
  return join(candidate, "Cargo.toml");
}
