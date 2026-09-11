/** Adversarial source archives, built in memory and delivered through the public upload endpoint. */
import { once } from "node:events";
import { createGzip, gzipSync } from "node:zlib";

/** A tar member as raw ustar bytes. `type` is the ustar typeflag: "0" file, "2" symlink, "5" dir. */
export interface TarMember {
  name: string;
  body?: string | Uint8Array;
  /** A body of `bytes` copies of one byte, emitted in chunks instead of held whole. */
  fill?: { byte: number; bytes: number };
  type?: "0" | "2" | "5";
  link?: string;
  mode?: number;
}

/** Bytes a member's body occupies, and the size its header declares. Links and dirs declare zero. */
function declaredSize(member: TarMember): number {
  if (member.type === "2" || member.type === "5") return 0;
  if (member.fill) return member.fill.bytes;
  if (typeof member.body === "string") return Buffer.byteLength(member.body, "utf8");
  return member.body?.length ?? 0;
}

function tarHeader(member: TarMember): Buffer {
  const header = Buffer.alloc(512, 0);
  const write = (value: string, offset: number, length: number) =>
    header.write(value.padEnd(length, "\0").slice(0, length), offset, "binary");
  const octal = (value: number, offset: number, length: number) =>
    write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);

  write(member.name, 0, 100);
  octal(member.mode ?? 0o644, 100, 8);
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(declaredSize(member), 124, 12);
  octal(0, 136, 12); // mtime — fixed, so an archive's bytes are reproducible across runs
  write("        ", 148, 8); // checksum placeholder: spaces, per the ustar spec
  write(member.type ?? "0", 156, 1);
  write(member.link ?? "", 157, 100);
  write("ustar\0", 257, 6);
  write("00", 263, 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);

  return header;
}

export function ustar(members: readonly TarMember[]): Buffer {
  const blocks: Buffer[] = [];

  for (const member of members) {
    if (member.fill) {
      throw new Error(
        `Member ${member.name} uses \`fill\`, which only \`targzStream\` can emit — see TarMember.fill.`
      );
    }
    const body =
      typeof member.body === "string"
        ? Buffer.from(member.body, "utf8")
        : Buffer.from(member.body ?? new Uint8Array());

    blocks.push(tarHeader(member));
    if (declaredSize(member) > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
      body.copy(padded);
      blocks.push(padded);
    }
  }

  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export function targz(members: readonly TarMember[]): Buffer {
  // Fixed mtime so the same member list always produces the same bytes — a case that submits the "same" archive
  // twice (E2E-DEDUP-01) must not accidentally change its own `source_sha256`.
  return gzipSync(ustar(members), { level: 9 });
}

/** One megabyte: large enough that a 512 MiB body is ~512 writes, small enough to be free. */
const FILL_CHUNK_BYTES = 1024 * 1024;

/** `targz` for a member list that may contain a `fill`, without ever holding the archive uncompressed. */
export async function targzStream(members: readonly TarMember[]): Promise<Buffer> {
  const gzip = createGzip({ level: 9 });
  const out: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => out.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    gzip.once("end", resolve);
    gzip.once("error", reject);
  });

  const put = async (buffer: Buffer) => {
    if (!gzip.write(buffer)) await once(gzip, "drain");
  };

  for (const member of members) {
    await put(tarHeader(member));
    const size = declaredSize(member);
    if (size === 0) continue;

    if (member.fill) {
      const chunk = Buffer.alloc(Math.min(FILL_CHUNK_BYTES, size), member.fill.byte);
      for (let written = 0; written < size; written += chunk.length) {
        const remaining = size - written;
        await put(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining));
      }
    } else {
      await put(
        typeof member.body === "string"
          ? Buffer.from(member.body, "utf8")
          : Buffer.from(member.body ?? new Uint8Array())
      );
    }

    const padding = (512 - (size % 512)) % 512;
    if (padding > 0) await put(Buffer.alloc(padding, 0));
  }

  await put(Buffer.alloc(1024, 0));
  gzip.end();
  await finished;
  return Buffer.concat(out);
}

/** How many entries survive `--strip-components 1`, and whether any of them escapes. */
function strippedPath(raw: string): { escapes: true } | { escapes: false; path?: string } {
  if (raw.startsWith("/") || raw.includes("\0")) return { escapes: true };
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return { escapes: true };
  const stripped = parts.slice(1);
  // A single-component member vanishes under `--strip-components 1` and is not counted, which is why `TOP`
  // exists: without it `Cargo.toml` would be one of these.
  return { escapes: false, path: stripped.length === 0 ? undefined : stripped.join("/") };
}

function materialisedEntries(members: readonly TarMember[]): number {
  let count = 0;
  for (const member of members) {
    const stripped = strippedPath(member.name);
    if (stripped.escapes) continue;
    if (stripped.path !== undefined) count += 1;
  }
  return count;
}

function declaredUncompressedBytes(members: readonly TarMember[]): number {
  return members.reduce((total, member) => total + declaredSize(member), 0);
}

const MINIMAL_CARGO = `[package]
name = "adversarial"
version = "0.0.1"
edition = "2021"

[lib]
crate-type = ["cdylib"]
`;

const PLACEHOLDER_LIB = "// placeholder\n";

/** The one directory every conformant member sits under — see the header on `stripComponents`. */
const TOP = "advtar";

/**
 * The conformant part of every variant: what a real archive would carry, so the only thing a refusal can be
 * about is the member appended after it.
 */
function baseMembers(): TarMember[] {
  return [
    { name: `${TOP}/`, type: "5", mode: 0o755 },
    { name: `${TOP}/Cargo.toml`, body: MINIMAL_CARGO },
    { name: `${TOP}/src/lib.rs`, body: PLACEHOLDER_LIB },
  ];
}

/** Materialised entries contributed by `baseMembers()` — the directory strips to nothing. */
const BASE_ENTRIES = 2;

export interface AdversarialArchive {
  /** The `F-ADV-*` ID, or a sub-case suffix from the case file. */
  readonly id: string;
  /** What it is trying to do, in the attacker's terms. */
  readonly attack: string;
  /**
   * The `source_archive_*` code `archive-extraction.ts` owes this archive — a **pointer, not an expectation
   * this file's consumers assert**.
   */
  readonly expectedReason: string;
  readonly bytes: Buffer;
  /** What goes over the wire — must stay under `LIMIT_ARCHIVE_BYTES` or the wrong control fires. */
  readonly compressedBytes: number;
  /** The sum of the header-declared sizes, which is what `totalUncompressedBytes` reads off `-tvf`. */
  readonly declaredUncompressedBytes: number;
  /** Entries left after `--strip-components 1`, which is what the entry bound counts. */
  readonly materialisedEntries: number;
}

function describeArchive(
  id: string,
  attack: string,
  expectedReason: string,
  members: readonly TarMember[],
  bytes: Buffer
): AdversarialArchive {
  return {
    id,
    attack,
    expectedReason,
    bytes,
    compressedBytes: bytes.length,
    declaredUncompressedBytes: declaredUncompressedBytes(members),
    materialisedEntries: materialisedEntries(members),
  };
}

export async function pathTraversalArchive(): Promise<AdversarialArchive> {
  const members: TarMember[] = [
    ...baseMembers(),
    // Left outside `TOP` deliberately: the escape has to survive `--strip-components 1`, and this one does —
    // `..` in any component is refused before the strip is applied.
    { name: "../../etc/scvs-e2e-escaped", body: "escaped\n" },
  ];
  return describeArchive(
    "F-ADV-TAR/path_traversal",
    "a member whose path climbs out of the extraction root",
    "source_archive_unsafe_path",
    members,
    targz(members)
  );
}

export async function symlinkEscapeArchive(): Promise<AdversarialArchive> {
  const members: TarMember[] = [
    ...baseMembers(),
    // Under `TOP`, so the *path* check passes and the refusal is attributable to the link check —
    // `firstUnsafeVerboseEntry` refuses any entry that is not a plain file or a directory.
    { name: `${TOP}/escape`, type: "2", link: "../../tmp", mode: 0o777 },
    { name: `${TOP}/escape/scvs-e2e-written-through-symlink`, body: "written\n" },
  ];
  return describeArchive(
    "F-ADV-TAR/symlink_escape",
    "a symlink pointing outside the root, then a later member writing through it",
    "source_archive_unsafe_link",
    members,
    targz(members)
  );
}

/** Exactly `LIMIT_TAR_ENTRIES + 1` materialised entries, and nothing else out of bounds. */
export async function entryCountBombArchive(limitTarEntries: number): Promise<AdversarialArchive> {
  if (!Number.isInteger(limitTarEntries) || limitTarEntries <= BASE_ENTRIES) {
    throw new Error(
      `LIMIT_TAR_ENTRIES must be an integer above ${BASE_ENTRIES} to build this fixture; got ${limitTarEntries}.`
    );
  }

  const members = baseMembers();
  // `BASE_ENTRIES` already count, so this many fillers land the total on exactly limit + 1.
  for (let index = 0; index < limitTarEntries + 1 - BASE_ENTRIES; index += 1) {
    members.push({ name: `${TOP}/filler/${index}.txt`, body: "x" });
  }

  return describeArchive(
    "F-ADV-TAR/entry_count_bomb",
    `${limitTarEntries + 1} materialised entries, exactly one past the declared LIMIT_TAR_ENTRIES`,
    "source_archive_too_many_entries",
    members,
    targz(members)
  );
}

/** A declared expansion of exactly `LIMIT_UNCOMPRESSED_BYTES + 1`, in three materialised entries. */
export async function sizeBombArchive(limitUncompressedBytes: number): Promise<AdversarialArchive> {
  const base = baseMembers();
  const conformantBytes = declaredUncompressedBytes(base);
  const bombBytes = limitUncompressedBytes + 1 - conformantBytes;
  if (!Number.isInteger(limitUncompressedBytes) || bombBytes <= 0) {
    throw new Error(
      `LIMIT_UNCOMPRESSED_BYTES must be an integer above ${conformantBytes} to build this fixture; ` +
        `got ${limitUncompressedBytes}.`
    );
  }

  const members: TarMember[] = [
    ...base,
    { name: `${TOP}/bomb.bin`, fill: { byte: 0x41, bytes: bombBytes } },
  ];

  return describeArchive(
    "F-ADV-TAR/size_bomb",
    `one member taking the declared expansion to LIMIT_UNCOMPRESSED_BYTES + 1 (${
      limitUncompressedBytes + 1
    } bytes)`,
    "source_archive_too_large_uncompressed",
    members,
    await targzStream(members)
  );
}

/** A perfectly ordinary archive — the control, and the payload for `F-ADV-SHA`. */
export function benignArchive(marker = "scvs-e2e"): AdversarialArchive {
  const members: TarMember[] = [
    { name: `${TOP}/`, type: "5", mode: 0o755 },
    { name: `${TOP}/Cargo.toml`, body: MINIMAL_CARGO },
    { name: `${TOP}/src/lib.rs`, body: `// ${marker}\npub fn nothing() {}\n` },
  ];
  return describeArchive(
    "control/benign",
    "none — the negative control",
    // Nothing is owed: this one is meant to get past every archive check.
    "",
    members,
    targz(members)
  );
}
