import type { RejectedBuildOption } from "../types";

const OPTIONS_TAKING_A_PATH = ["--manifest-path", "--target-dir", "--out-dir"] as const;

const OPTIONS_NOT_REPLAYABLE = ["--offline", "--config", "--env", "--target-dir", "--out-dir"] as const;

export const splitBuildOptions = (raw?: string): string[] =>
  raw ? raw.trim().split(/\s+/).filter(Boolean) : [];

const SEP58_BLDOPT_ENTRY = /^--[A-Za-z][A-Za-z0-9_-]*(=.+)?$/;

export type BuildOptionsCheck =
  | { ok: true; normalized: string[] }
  | { ok: false; rejected: RejectedBuildOption[] };

export const validateBuildOptions = (raw: string | undefined): BuildOptionsCheck => {
  const entries = splitBuildOptions(raw);
  const rejected: RejectedBuildOption[] = [];
  const normalized: string[] = [];

  for (const [index, entry] of entries.entries()) {
    const [flag, ...rest] = entry.split("=");
    const value = rest.join("=");

    if (!SEP58_BLDOPT_ENTRY.test(entry)) {
      const previous = index > 0 ? entries[index - 1] : undefined;
      const detail =
        previous && /^--[A-Za-z][A-Za-z0-9_-]*$/.test(previous) && !entry.startsWith("-")
          ? `Write \`${previous}=${entry}\` as one option. Each build option is a complete flag with its value attached by \`=\` — a flag and its value cannot be separated by a space.`
          : /^-[A-Za-z]/.test(entry)
            ? `\`${entry}\` is a short flag, which cannot be recorded. Use the long form, e.g. \`--package=my-contract\` rather than \`-p my-contract\`.`
            : `\`${entry}\` is not a build option. Each one is a complete flag beginning with \`--\`, with its value attached by \`=\`.`;
      rejected.push({ option: entry, reason: "unparsable", detail });
      continue;
    }

    if (OPTIONS_NOT_REPLAYABLE.includes(flag as (typeof OPTIONS_NOT_REPLAYABLE)[number])) {
      rejected.push({
        option: entry,
        reason: "not_replayable",
        detail: `${flag} changes the build environment itself, which the recipe — not the submitter — determines.`,
      });
      continue;
    }

    if (!OPTIONS_TAKING_A_PATH.includes(flag as (typeof OPTIONS_TAKING_A_PATH)[number])) {
      normalized.push(entry);
      continue;
    }

    if (!value) {
      rejected.push({
        option: entry,
        reason: "unparsable",
        detail: `${flag} needs a path, written as ${flag}=<path>.`,
      });
      continue;
    }

    const path = normalizeRelativePath(value);
    if (path === null) {
      rejected.push({
        option: entry,
        reason: "path_escapes_source_tree",
        detail: `${flag} must stay inside the submitted source archive. Absolute paths and paths that climb above its root cannot be replayed.`,
      });
      continue;
    }

    normalized.push(`${flag}=${path}`);
  }

  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, normalized };
};

const normalizeRelativePath = (value: string): string | null => {
  if (value.startsWith("/")) return null;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return null;

  const out: string[] = [];
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.length > 0 ? out.join("/") : ".";
};
