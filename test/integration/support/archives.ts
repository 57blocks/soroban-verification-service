import { once } from "node:events";
import { createGzip, gzipSync } from "node:zlib";

/** `type` is the ustar typeflag: "0" file, "2" symlink, "5" dir. */
export interface TarMember {
  name: string;
  body?: string | Uint8Array;
  fill?: { byte: number; bytes: number };
  type?: "0" | "2" | "5";
  link?: string;
  mode?: number;
}

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

  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export function targz(members: readonly TarMember[]): Buffer {
  return gzipSync(ustar(members), { level: 9 });
}

const FILL_CHUNK_BYTES = 1024 * 1024;

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

function strippedPath(raw: string): { escapes: true } | { escapes: false; path?: string } {
  if (raw.startsWith("/") || raw.includes("\0")) return { escapes: true };
  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return { escapes: true };
  const stripped = parts.slice(1);
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

const TOP = "advtar";

function baseMembers(): TarMember[] {
  return [
    { name: `${TOP}/`, type: "5", mode: 0o755 },
    { name: `${TOP}/Cargo.toml`, body: MINIMAL_CARGO },
    { name: `${TOP}/src/lib.rs`, body: PLACEHOLDER_LIB },
  ];
}

const BASE_ENTRIES = 2;

export interface AdversarialArchive {
  readonly id: string;
  readonly attack: string;
  readonly expectedReason: string;
  readonly bytes: Buffer;
  readonly compressedBytes: number;
  readonly declaredUncompressedBytes: number;
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

export async function entryCountBombArchive(limitTarEntries: number): Promise<AdversarialArchive> {
  if (!Number.isInteger(limitTarEntries) || limitTarEntries <= BASE_ENTRIES) {
    throw new Error(
      `LIMIT_TAR_ENTRIES must be an integer above ${BASE_ENTRIES} to build this fixture; got ${limitTarEntries}.`
    );
  }

  const members = baseMembers();
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

export function benignArchive(marker = "scvs-e2e"): AdversarialArchive {
  const members: TarMember[] = [
    { name: `${TOP}/`, type: "5", mode: 0o755 },
    { name: `${TOP}/Cargo.toml`, body: MINIMAL_CARGO },
    { name: `${TOP}/src/lib.rs`, body: `// ${marker}\npub fn nothing() {}\n` },
  ];
  return describeArchive(
    "control/benign",
    "none — the negative control",
    "",
    members,
    targz(members)
  );
}
