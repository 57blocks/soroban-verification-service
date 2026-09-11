import { copyFile, link, mkdir, mkdtemp, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { ARCHIVE_HEAD_BYTES, sniffArchiveFormatFromHead, type ArchiveFormat } from "@scvs/core";

/**
 * What `stellar contract verify` will accept as a source archive, and what it does with a name that is not one
 * of these.
 */
export const CLI_ACCEPTED_ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".zip"] as const;

/**
 * Re-exported so this module stays the one place the *extractor* asks about formats, while the magic-number
 * table itself has a single owner in `@scvs/core`.
 */
export type { ArchiveFormat };

/** The suffix a given format's file must end in for the CLI to accept it, or none if it cannot. */
const ACCEPTED_SUFFIX: Record<ArchiveFormat, readonly string[]> = {
  gzip: [".tar.gz", ".tgz"],
  zip: [".zip"],
  tar: [],
  unknown: [],
};

export function hasCliAcceptedArchiveSuffix(path: string): boolean {
  const name = basename(path).toLowerCase();
  return CLI_ACCEPTED_ARCHIVE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** The archive's format from its magic number, read off a path. */
export async function sniffArchiveFormat(path: string): Promise<ArchiveFormat> {
  const head = await readHead(path, ARCHIVE_HEAD_BYTES);
  return head ? sniffArchiveFormatFromHead(head) : "unknown";
}

export type AlignedArchiveName = {
  /** The path to hand the CLI — the input path when it was already acceptable or cannot be made so. */
  path: string;
  format: ArchiveFormat;
  /** How `path` was arrived at. Diagnostic only; no caller branches on it. */
  alignment: "already_accepted" | "linked" | "copied" | "no_accepted_name" | "link_failed";
};

/** Give an archive a name `stellar contract verify` accepts, without touching its bytes or its original path. */
export async function alignArchiveNameForCli(input: {
  localPath: string;
  artifactRoot: string;
}): Promise<AlignedArchiveName> {
  const format = await sniffArchiveFormat(input.localPath);
  const accepted = ACCEPTED_SUFFIX[format];
  if (accepted.length === 0) {
    return { path: input.localPath, format, alignment: "no_accepted_name" };
  }
  const name = basename(input.localPath).toLowerCase();
  if (accepted.some((suffix) => name.endsWith(suffix))) {
    return { path: input.localPath, format, alignment: "already_accepted" };
  }

  // Appended, not substituted: `counter.zip` holding gzip bytes becomes `counter.zip.tar.gz`, which reads oddly
  // and is right.
  const aligned = `${basename(input.localPath)}${accepted[0]}`;
  try {
    const placed = await placeArchive(input.localPath, input.artifactRoot, aligned);
    return { path: placed.path, format, alignment: placed.how };
  } catch {
    return { path: input.localPath, format, alignment: "link_failed" };
  }
}

/**
 * Put an archive somewhere this container owns, keeping its name, so whatever staging directory it was written
 * into can be removed.
 */
export async function adoptArchive(input: { localPath: string; artifactRoot: string }): Promise<string> {
  const placed = await placeArchive(input.localPath, input.artifactRoot, basename(input.localPath));
  return placed.path;
}

/** A hard link in a fresh directory, falling back to a copy on `EXDEV`. */
async function placeArchive(
  localPath: string,
  artifactRoot: string,
  name: string,
): Promise<{ path: string; how: "linked" | "copied" }> {
  // `recursive` because a local-path source reaches here without anything having created the root: only the
  // download and clone arms make it on their way past.
  await mkdir(artifactRoot, { recursive: true });
  const dir = await mkdtemp(join(artifactRoot, "archive-"));
  const path = join(dir, name);
  try {
    await link(localPath, path);
    return { path, how: "linked" };
  } catch {
    await copyFile(localPath, path);
    return { path, how: "copied" };
  }
}

async function readHead(path: string, length: number): Promise<Buffer | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
