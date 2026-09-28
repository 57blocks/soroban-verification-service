import type { RebuildErrorCode } from "@scvs/core";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { sniffArchiveFormat, type ArchiveFormat } from "./archive-format.js";
import { runCommand, type CommandResult } from "@scvs/core/process";
import { cliTimeoutMs } from "./run-cli.config.js";
import type { RunCliRuntimeConfig } from "./run-cli.types.js";

export type ExtractionOptions = {
  fileMode: number;
  dirMode: number;
  stripComponents: 0 | 1;
};

export type ExtractionOptionsInput = Partial<ExtractionOptions>;

export const DEFAULT_EXTRACTION_OPTIONS: ExtractionOptions = {
  fileMode: 0o644,
  dirMode: 0o755,
  stripComponents: 1,
};

export type ArchiveLimits = {
  maxEntries: number;
  maxUncompressedBytes: number;
};

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 20_000,
  maxUncompressedBytes: 512 * 1024 * 1024,
};

export type ExtractSourceArchiveResult =
  | {
      ok: true;
      source_root: string;
      normalisation: ExtractionOptions;
      canonicalisation?: Canonicalisation;
    }
  | { ok: false; reason: RebuildErrorCode; detail: string; extract?: CommandResult };

type ExtractionFailure = Extract<ExtractSourceArchiveResult, { ok: false }>;

/** Which binary reads which container format, chosen from the bytes and never from the filename. */
export function archiveReaderFor(format: ArchiveFormat): string {
  return format === "zip" ? "bsdtar" : "tar";
}

function readerUnavailable(
  result: CommandResult,
  reader: string,
  format: ArchiveFormat,
): ExtractSourceArchiveResult | undefined {
  if (!result.error) return undefined;
  return {
    ok: false,
    reason: "source_archive_reader_unavailable",
    detail:
      `This verifier could not run \`${reader}\`, the reader for a ${format} source archive, in the ` +
      `builder image (${result.error}). The submitted source is not the problem.`,
    extract: result,
  };
}

export type ExtractSourceArchiveInput = {
  archivePath: string;
  destRoot: string;
  options?: ExtractionOptionsInput;
  limits?: ArchiveLimits;
  config?: RunCliRuntimeConfig;
  listing?: string;
};

export const MAX_UNWRAP_DEPTH = 4;

export type Canonicalisation = {
  depth: number;
  outer_format: ArchiveFormat;
  canonical_format: ArchiveFormat;
  peeled: Array<{ member: string; format: ArchiveFormat }>;
};

export type CanonicaliseResult =
  | {
      ok: true;
      archivePath: string;
      canonicalisation: Canonicalisation;
      limits: ArchiveLimits;
      listing: string;
      dispose: () => Promise<void>;
    }
  | ExtractionFailure;

export type CanonicaliseSourceArchiveInput = {
  archivePath: string;
  stagePrefix: string;
  limits?: ArchiveLimits;
  config?: RunCliRuntimeConfig;
};

export async function canonicaliseSourceArchive(
  input: CanonicaliseSourceArchiveInput,
): Promise<CanonicaliseResult> {
  const timeout_ms = cliTimeoutMs(input.config);
  const outer_format = await sniffArchiveFormat(input.archivePath);

  let archivePath = input.archivePath;
  let format = outer_format;
  let limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const peeled: Canonicalisation["peeled"] = [];
  let peelRoot: string | undefined;
  let previousStage: string | undefined;

  const stopHere = (listing: string): CanonicaliseResult => ({
    ok: true,
    archivePath,
    canonicalisation: { depth: peeled.length, outer_format, canonical_format: format, peeled },
    limits,
    listing,
    dispose: async () => {
      if (peelRoot) await rm(peelRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  });

  for (;;) {
    const reader = archiveReaderFor(format);
    const list = await runCommand([reader, "-tf", archivePath], { timeout_ms, mirrorOutput: false });
    if (list.exit_code !== 0) {
      return (
        (readerUnavailable(list, reader, format) as ExtractionFailure | undefined) ?? {
          ok: false,
          reason: "source_archive_extract_failed",
          detail: `Could not list the submitted source archive (detected ${format}, read with ${reader}) before extraction.`,
          extract: list,
        }
      );
    }

    const member = wrappedArchiveMember(list.stdout);
    if (!member) return stopHere(list.stdout);

    if (peeled.length >= MAX_UNWRAP_DEPTH) {
      return {
        ok: false,
        reason: "source_archive_nested_too_deep",
        detail:
          `Source archive nests containers more than ${MAX_UNWRAP_DEPTH} levels deep ` +
          `(${peeled.map((entry) => `${entry.format}:${entry.member}`).join(" -> ")} -> ` +
          `${format}:${member}). Submit the source archive itself — the innermost .tar.gz or .tgz — ` +
          "rather than a recompressed copy of it.",
      };
    }

    const validation = validateArchiveEntries(
      list.stdout,
      { ...DEFAULT_EXTRACTION_OPTIONS, stripComponents: 0 },
      limits,
    );
    if (!validation.ok) return validation as ExtractionFailure;

    const inspected = await inspectArchive({ reader, format, archivePath, timeout_ms, limits });
    if (!inspected.ok) return inspected;

    if (!peelRoot) {
      await mkdir(dirname(input.stagePrefix), { recursive: true });
      peelRoot = await mkdtemp(input.stagePrefix);
    }
    const stage = await mkdtemp(join(peelRoot, `level-${peeled.length + 1}-`));
    const extract = await runCommand([reader, "-xf", archivePath, "-C", stage], { timeout_ms });

    // The member's presence decides success, not the reader's exit code.
    const inner = join(stage, member);
    const present = await lstat(inner)
      .then((info) => info.isFile())
      .catch(() => false);
    if (!present) {
      return (
        (readerUnavailable(extract, reader, format) as ExtractionFailure | undefined) ?? {
          ok: false,
          reason: "source_archive_extract_failed",
          detail:
            `Could not extract "${member}", the single member of a nested ${format} source archive ` +
            `(read with ${reader}).`,
          extract,
        }
      );
    }

    const innerFormat = await sniffArchiveFormat(inner);
    if (innerFormat === "unknown") {
      return {
        ok: false,
        reason: "source_archive_nested_unsupported",
        detail:
          `The submitted ${format} archive contains a single member "${member}", and those bytes are ` +
          "not an archive this verifier reads (a .tar.gz, .tgz, .zip or bare .tar is required). " +
          "Submit the source archive itself rather than a container holding one file.",
      };
    }

    peeled.push({ member, format });
    // Clamped at 0: a negative ceiling would read as "unbounded" to every `>` comparison downstream.
    limits = {
      ...limits,
      maxUncompressedBytes: Math.max(0, limits.maxUncompressedBytes - inspected.bytes),
    };
    if (previousStage) await rm(previousStage, { recursive: true, force: true }).catch(() => undefined);
    previousStage = stage;
    archivePath = inner;
    format = innerFormat;
  }
}

export async function extractSourceArchive(
  input: ExtractSourceArchiveInput,
): Promise<ExtractSourceArchiveResult> {
  const canonical = await canonicaliseSourceArchive({
    archivePath: input.archivePath,
    stagePrefix: `${input.destRoot}-peel-`,
    limits: input.limits,
    config: input.config,
  });
  if (!canonical.ok) return canonical;

  try {
    const extracted = await extractCanonicalArchive({
      ...input,
      archivePath: canonical.archivePath,
      limits: canonical.limits,
      listing: canonical.listing,
    });
    if (!extracted.ok || canonical.canonicalisation.depth === 0) return extracted;
    return { ...extracted, canonicalisation: canonical.canonicalisation };
  } finally {
    await canonical.dispose();
  }
}

export async function extractCanonicalArchive(
  input: ExtractSourceArchiveInput,
): Promise<ExtractSourceArchiveResult> {
  const { archivePath, destRoot } = input;
  const limits = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const config = input.config;
  await mkdir(destRoot, { recursive: true });
  const timeout_ms = cliTimeoutMs(config);
  const format = await sniffArchiveFormat(archivePath);
  const reader = archiveReaderFor(format);

  let listing = input.listing;
  if (listing === undefined) {
    const list = await runCommand([reader, "-tf", archivePath], { timeout_ms, mirrorOutput: false });
    if (list.exit_code !== 0) {
      return (
        readerUnavailable(list, reader, format) ?? {
          ok: false,
          reason: "source_archive_extract_failed",
          detail: `Could not list the submitted source archive (detected ${format}, read with ${reader}) before extraction.`,
          extract: list,
        }
      );
    }
    listing = list.stdout;
  }

  const options: ExtractionOptions = {
    fileMode: input.options?.fileMode ?? DEFAULT_EXTRACTION_OPTIONS.fileMode,
    dirMode: input.options?.dirMode ?? DEFAULT_EXTRACTION_OPTIONS.dirMode,
    stripComponents: input.options?.stripComponents ?? stripDepthFor(listing),
  };

  const validation = validateArchiveEntries(listing, options, limits);
  if (!validation.ok) return validation;

  const inspected = await inspectArchive({ reader, format, archivePath, timeout_ms, limits });
  if (!inspected.ok) return inspected;

  const extract = await runCommand(
    [reader, "-xf", archivePath, "-C", destRoot, "--strip-components", String(options.stripComponents)],
    { timeout_ms },
  );
  if (extract.exit_code !== 0) {
    return {
      ok: false,
      reason: "source_archive_extract_failed",
      detail: `Could not extract the submitted source archive (detected ${format}, read with ${reader}) for manual rebuild.`,
      extract,
    };
  }

  const normalised = await normaliseExtractedTree(destRoot, options);
  if (!normalised.ok) return normalised;

  return {
    ok: true,
    source_root: await resolveSourceRoot(destRoot, options),
    normalisation: options,
  };
}

export function stripDepthFor(listing: string): 0 | 1 {
  const tops = new Set<string>();
  let entries = 0;
  for (const raw of listing.split(/\r?\n/)) {
    const entry = raw.trim();
    if (!entry || isArchiverDropping(entry)) continue;
    const parts = entry.split("/").filter((part) => part.length > 0 && part !== ".");
    if (parts.length === 0) continue;
    entries += 1;
    // Both readers print a trailing slash for a directory member.
    if (parts.length === 1 && !entry.endsWith("/")) return 0;
    tops.add(parts[0]);
    if (tops.size > 1) return 0;
  }
  return entries > 0 && tops.size === 1 ? 1 : 0;
}

async function inspectArchive(args: {
  reader: string;
  format: ArchiveFormat;
  archivePath: string;
  timeout_ms: number;
  limits: ArchiveLimits;
}): Promise<{ ok: true; bytes: number } | ExtractionFailure> {
  const { reader, format, archivePath, timeout_ms, limits } = args;
  // Pinned: a non-English LC_TIME makes BSD tar print a numeric month, which timestampIndex must not accept.
  const verbose = await runCommand([reader, "-tvf", archivePath], {
    timeout_ms,
    mirrorOutput: false,
    env: { LC_ALL: "C" },
  });
  if (verbose.exit_code !== 0) {
    return {
      ok: false,
      reason: "source_archive_extract_failed",
      detail: `Could not inspect the submitted source archive (detected ${format}, read with ${reader}) before extraction.`,
      extract: verbose,
    };
  }
  const link = firstUnsafeVerboseEntry(verbose.stdout);
  if (link) {
    return {
      ok: false,
      reason: "source_archive_unsafe_link",
      detail: `Source archive contains a link entry that would not be byte-neutral to extract: ${link}.`,
      extract: verbose,
    };
  }

  const size = totalUncompressedBytes(verbose.stdout);
  if (!size.ok) {
    // Fail closed: an archive whose expansion cannot be measured must not read as one that fits.
    return {
      ok: false,
      reason: "source_archive_unreadable",
      detail: `Could not read a size for every entry in the archive listing: ${size.detail}`,
      extract: verbose,
    };
  }
  if (size.bytes > limits.maxUncompressedBytes) {
    return {
      ok: false,
      reason: "source_archive_too_large_uncompressed",
      detail:
        `Source archive expands to ${size.bytes} bytes, exceeding limit ${limits.maxUncompressedBytes}.`,
      extract: verbose,
    };
  }
  return { ok: true, bytes: size.bytes };
}

function wrappedArchiveMember(stdout: string): string | undefined {
  const entries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const files = entries.filter((entry) => !entry.endsWith("/") && !isArchiverDropping(entry));
  if (files.length !== 1) return undefined;
  const parts = files[0].split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length !== 1) return undefined;
  return files[0];
}

function isArchiverDropping(entry: string): boolean {
  const parts = entry.split("/").filter((part) => part.length > 0 && part !== ".");
  const name = parts[parts.length - 1] ?? "";
  return parts[0] === "__MACOSX" || name.startsWith("._") || name === ".DS_Store";
}

export function formatExtractionNormalisation(options: ExtractionOptions): string {
  return [
    `file=${modeString(options.fileMode)}`,
    `dir=${modeString(options.dirMode)}`,
    `strip=${options.stripComponents}`,
  ].join(",");
}

function validateArchiveEntries(
  stdout: string,
  options: ExtractionOptions,
  limits: ArchiveLimits,
): ExtractSourceArchiveResult | { ok: true } {
  let materializedEntries = 0;
  for (const rawEntry of stdout.split(/\r?\n/).filter(Boolean)) {
    const stripped = stripArchivePath(rawEntry, options.stripComponents);
    if (stripped === undefined) continue;
    if (stripped.ok === false) {
      return {
        ok: false,
        reason: "source_archive_unsafe_path",
        detail: `Source archive contains unsafe path: ${rawEntry}.`,
      };
    }
    materializedEntries += 1;
    if (materializedEntries > limits.maxEntries) {
      return {
        ok: false,
        reason: "source_archive_too_many_entries",
        detail: `Source archive contains more than ${limits.maxEntries} entries.`,
      };
    }
  }
  if (materializedEntries === 0) {
    return {
      ok: false,
      reason: "source_archive_layout_invalid",
      detail: "Source archive contains no entries after extraction path normalisation.",
    };
  }
  return { ok: true };
}

function stripArchivePath(
  rawPath: string,
  stripComponents: 0 | 1,
): { ok: true; path: string } | { ok: false } | undefined {
  if (rawPath.startsWith("/") || rawPath.includes("\0")) return { ok: false };
  const parts = rawPath.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return { ok: false };
  const stripped = parts.slice(stripComponents);
  if (stripped.length === 0) return undefined;
  const normalized = posix.normalize(stripped.join("/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    return { ok: false };
  }
  return { ok: true, path: normalized };
}

export function totalUncompressedBytes(
  stdout: string,
): { ok: true; bytes: number } | { ok: false; detail: string } {
  let total = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Non-regular entries never reach here: the link check has already rejected them.
    const fields = trimmed.split(/\s+/);
    const dateIndex = timestampIndex(fields);
    if (dateIndex < 1) {
      return { ok: false, detail: `no timestamp field in listing line "${trimmed}"` };
    }
    const size = Number(fields[dateIndex - 1]);
    if (!/^\d+$/.test(fields[dateIndex - 1]) || !Number.isSafeInteger(size)) {
      return { ok: false, detail: `unreadable size in listing line "${trimmed}"` };
    }
    total += size;
  }
  return { ok: true, bytes: total };
}

function timestampIndex(fields: string[]): number {
  const isTime = (f?: string) => f !== undefined && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(f);
  const isYear = (f?: string) => f !== undefined && /^\d{4}$/.test(f);
  const isDay = (f?: string) => f !== undefined && /^\d{1,2}$/.test(f);

  for (let i = 0; i < fields.length; i += 1) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(fields[i]) && isTime(fields[i + 1])) return i;
    if (
      /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(fields[i]) &&
      isDay(fields[i + 1]) &&
      (isTime(fields[i + 2]) || isYear(fields[i + 2]))
    ) {
      return i;
    }
  }
  return -1;
}

function firstUnsafeVerboseEntry(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).find((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const type = trimmed[0];
    return type !== "-" && type !== "d";
  });
}

async function normaliseExtractedTree(
  root: string,
  options: ExtractionOptions,
): Promise<ExtractSourceArchiveResult | { ok: true }> {
  const entries = await readdir(root, { withFileTypes: true });
  await chmod(root, options.dirMode);
  for (const entry of entries) {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return {
        ok: false,
        reason: "source_archive_unsafe_link",
        detail: `Source archive extracted a link entry: ${entry.name}.`,
      };
    }
    if (info.isDirectory()) {
      const child = await normaliseExtractedTree(path, options);
      if (!child.ok) return child;
      continue;
    }
    if (!info.isFile()) {
      return {
        ok: false,
        reason: "source_archive_unsupported_entry",
        detail: `Source archive extracted an unsupported entry type: ${entry.name}.`,
      };
    }
    await chmod(path, options.fileMode);
  }
  return { ok: true };
}

async function resolveSourceRoot(destRoot: string, options: ExtractionOptions): Promise<string> {
  if (options.stripComponents === 1) return destRoot;
  const entries = await readdir(destRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  if (dirs.length === 1 && files.length === 0) return join(destRoot, dirs[0].name);
  return destRoot;
}

function modeString(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}
