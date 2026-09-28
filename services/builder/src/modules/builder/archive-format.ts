import { copyFile, link, mkdir, mkdtemp, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { ARCHIVE_HEAD_BYTES, sniffArchiveFormatFromHead, type ArchiveFormat } from "@scvs/core";

export const CLI_ACCEPTED_ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".zip"] as const;

export type { ArchiveFormat };

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

export async function sniffArchiveFormat(path: string): Promise<ArchiveFormat> {
  const head = await readHead(path, ARCHIVE_HEAD_BYTES);
  return head ? sniffArchiveFormatFromHead(head) : "unknown";
}

export type AlignedArchiveName = {
  path: string;
  format: ArchiveFormat;
  alignment: "already_accepted" | "linked" | "copied" | "no_accepted_name" | "link_failed";
};

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

  const aligned = `${basename(input.localPath)}${accepted[0]}`;
  try {
    const placed = await placeArchive(input.localPath, input.artifactRoot, aligned);
    return { path: placed.path, format, alignment: placed.how };
  } catch {
    return { path: input.localPath, format, alignment: "link_failed" };
  }
}

export async function adoptArchive(input: { localPath: string; artifactRoot: string }): Promise<string> {
  const placed = await placeArchive(input.localPath, input.artifactRoot, basename(input.localPath));
  return placed.path;
}

async function placeArchive(
  localPath: string,
  artifactRoot: string,
  name: string,
): Promise<{ path: string; how: "linked" | "copied" }> {
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
