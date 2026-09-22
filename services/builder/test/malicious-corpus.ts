import { deflateRawSync } from "node:zlib";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@scvs/core/process";

/** **T5's adversarial corpus** — one archive per attack, each with the reason code the extractor owes it. */
export type MaliciousArchive = {
  /** Stable id, used as the test name and as the thing a failure report names. */
  id: string;
  /** What the archive is trying to do, in the attacker's terms. */
  attack: string;
  /** The reason code the extractor must answer with. */
  reason: string;
  /** Builds the archive under `root`, returning its path. */
  build: (root: string) => Promise<string>;
};

/** A tar member, as raw ustar bytes. `type` is the ustar typeflag. */
type Member = { name: string; body?: string; type?: string; link?: string; mode?: number };

/** Writes a ustar archive containing exactly `members`. */
export function ustarArchive(members: Member[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const body = member.body ?? "";
    const header = Buffer.alloc(512, 0);
    const write = (value: string, offset: number, length: number) =>
      header.write(value.padEnd(length, "\0").slice(0, length), offset, "binary");
    const octal = (value: number, offset: number, length: number) =>
      write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);

    write(member.name, 0, 100);
    octal(member.mode ?? 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    // A link entry carries no payload; its target lives in the linkname field.
    octal(member.type === "1" || member.type === "2" ? 0 : body.length, 124, 12);
    octal(0, 136, 12);
    write("        ", 148, 8); // checksum placeholder: spaces, per the format
    write(member.type ?? "0", 156, 1);
    write(member.link ?? "", 157, 100);
    write("ustar\0", 257, 6);
    write("00", 263, 2);
    write("root", 265, 32);
    write("root", 297, 32);

    let checksum = 0;
    for (const byte of header) checksum += byte;
    write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);

    blocks.push(header);
    if (member.type === undefined || member.type === "0") {
      const content = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
      content.write(body, 0, "binary");
      blocks.push(content);
    }
  }
  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

const raw = (name: string, members: Member[]) => async (root: string) => {
  const archive = join(root, name);
  await writeFile(archive, ustarArchive(members));
  return archive;
};

/** A zip member. `link` makes it a symlink whose target is the body; otherwise it is a regular file. */
export type ZipMember = { name: string; body?: string; link?: string; mode?: number };

/**
 * Writes a deflate zip containing exactly `members` — the zip half of `ustarArchive`, and hand-rolled for the
 * same reason.
 */
export function zipArchive(members: ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const isLink = member.link !== undefined;
    const raw = Buffer.from(isLink ? member.link! : (member.body ?? ""), "latin1");
    const name = Buffer.from(member.name, "latin1");
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);
    const mode = member.mode ?? (isLink ? 0o120777 : 0o100644);
    // 1980-01-01, the epoch of the DOS timestamp this format carries.
    const dosDate = 0x0021;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size — what the size bound reads
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory header signature
    entry.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk number start
    entry.writeUInt16LE(0, 36); // internal attributes
    // `* 0x10000`, not `<< 16`: S_IFLNK|0777 shifted left 16 overflows a signed 32-bit int and writeUInt32LE
    // would throw on the negative result.
    entry.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, directory, end]);
}

/** CRC-32, written out rather than taken from `node:zlib`'s `crc32`, which only exists from Node 20.15. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

const zip = (name: string, members: ZipMember[]) => async (root: string) => {
  const archive = join(root, name);
  await writeFile(archive, zipArchive(members));
  return archive;
};

/** Builds a real archive with the local `tar`, for attacks the create path can express. */
async function tarOf(root: string, entry: string, name = "source.tar"): Promise<string> {
  const archive = join(root, name);
  const result = await runCommand(["tar", "-cf", archive, "-C", root, entry], { mirrorOutput: false });
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || result.error || "tar fixture failed");
  }
  return archive;
}

export const MALICIOUS_ARCHIVES: readonly MaliciousArchive[] = [
  {
    id: "traversal-parent",
    attack: "A member named `../escape.txt`, to write one directory above the extraction root.",
    reason: "source_archive_unsafe_path",
    build: raw("traversal-parent.tar", [{ name: "../escape.txt", body: "escaped\n" }]),
  },
  {
    id: "traversal-deep",
    attack:
      "A member that climbs several levels — `pkg/../../../../etc/passwd` — so a validator that only " +
      "checks the first segment, or normalises without re-checking, lets it through.",
    reason: "source_archive_unsafe_path",
    build: raw("traversal-deep.tar", [
      { name: "pkg/../../../../etc/scvs-owned", body: "owned\n" },
    ]),
  },
  {
    id: "traversal-absolute",
    attack: "An absolute member path, `/etc/scvs-owned`, which ignores the extraction root entirely.",
    reason: "source_archive_unsafe_path",
    build: raw("traversal-absolute.tar", [{ name: "/etc/scvs-owned", body: "owned\n" }]),
  },
  {
    id: "traversal-hidden-among-valid",
    attack:
      "One escaping member buried among conformant ones, so a validator that stops at the first good " +
      "entry — or samples — misses it.",
    reason: "source_archive_unsafe_path",
    build: raw("traversal-hidden.tar", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/src/lib.rs", body: "pub fn hello() {}\n" },
      { name: "pkg/../../escape.txt", body: "escaped\n" },
    ]),
  },
  {
    id: "symlink-escape-absolute",
    attack: "A symlink member pointing at `/etc/passwd`, to read a host file once anything follows it.",
    reason: "source_archive_unsafe_link",
    build: raw("symlink-absolute.tar", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/passwd", type: "2", link: "/etc/passwd" },
    ]),
  },
  {
    id: "symlink-escape-relative",
    attack:
      "A symlink climbing out with `../../..`, which an absolute-path check alone would not catch.",
    reason: "source_archive_unsafe_link",
    build: raw("symlink-relative.tar", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/out", type: "2", link: "../../../etc" },
    ]),
  },
  {
    id: "hardlink-escape",
    attack:
      "A hard link out of the tree. Distinct from a symlink: it is a different typeflag, so a check " +
      "written against symlinks only would pass this.",
    reason: "source_archive_unsafe_link",
    build: raw("hardlink.tar", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/passwd", type: "1", link: "/etc/passwd" },
    ]),
  },
  {
    id: "device-node",
    attack:
      "A character-device member. Not a traversal, but not source either — extracting device nodes " +
      "from submitted input is a capability the sandbox has no reason to exercise.",
    // `firstUnsafeVerboseEntry` is a **whitelist**.
    reason: "source_archive_unsafe_link",
    build: raw("device.tar", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/zero", type: "3" },
    ]),
  },
  {
    id: "entry-count-bomb",
    attack: "More members than the entry ceiling allows, to exhaust inodes or extraction time.",
    reason: "source_archive_too_many_entries",
    build: raw(
      "entry-bomb.tar",
      Array.from({ length: 40 }, (_, index) => ({
        name: `pkg/file-${index}.txt`,
        body: "x",
      })),
    ),
  },
  {
    id: "uncompressed-size-bomb",
    attack:
      "A small archive declaring a large expansion, the classic compression-ratio bomb — the size is " +
      "read from the listing, so this is caught before anything is written to disk.",
    reason: "source_archive_too_large_uncompressed",
    build: async (root: string) => {
      const source = join(root, "pkg");
      await mkdir(source, { recursive: true });
      // Highly compressible, so the archive stays small while the declared expansion is large.
      await writeFile(join(source, "big.bin"), "0".repeat(4 * 1024 * 1024));
      return tarOf(root, "pkg", "size-bomb.tar");
    },
  },
  // ── zip ────────────────────────────────────────────────────────────────────────────────────────
  // Every attack above, re-expressed in the second container format the extractor now reads.
  {
    id: "zip-traversal-parent",
    attack: "A zip member named `pkg/../../escape.txt`, to write outside the extraction root.",
    reason: "source_archive_unsafe_path",
    build: zip("traversal.zip", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/../../escape.txt", body: "escaped\n" },
    ]),
  },
  {
    id: "zip-traversal-absolute",
    attack:
      "An absolute zip member path. Worth its own case: Python's `zipfile` — the other zip reader " +
      "present in the builder image — silently rewrites this to a relative path inside the " +
      "destination instead of refusing it, so 'some unpacker handled it' is not the same as 'it was " +
      "caught'.",
    reason: "source_archive_unsafe_path",
    build: zip("absolute.zip", [{ name: "/etc/scvs-owned", body: "owned\n" }]),
  },
  {
    id: "zip-symlink-escape",
    attack:
      "A zip member flagged `S_IFLNK` in its Unix external attributes, pointing at `/etc/passwd`. " +
      "Expressible only by writing the central directory by hand.",
    reason: "source_archive_unsafe_link",
    build: zip("symlink.zip", [
      { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
      { name: "pkg/passwd", link: "/etc/passwd" },
    ]),
  },
  {
    id: "zip-entry-count-bomb",
    attack: "More zip members than the entry ceiling allows.",
    reason: "source_archive_too_many_entries",
    build: zip(
      "entry-bomb.zip",
      Array.from({ length: 40 }, (_, index) => ({ name: `pkg/file-${index}.txt`, body: "x" })),
    ),
  },
  {
    id: "zip-uncompressed-size-bomb",
    attack:
      "A ~4 KB zip declaring a 4 MB expansion. The deflate ratio is real — the member is written " +
      "compressed — so this is the genuine ratio bomb, caught off the listing before a byte is " +
      "written.",
    reason: "source_archive_too_large_uncompressed",
    build: zip("size-bomb.zip", [{ name: "pkg/big.bin", body: "0".repeat(4 * 1024 * 1024) }]),
  },
  {
    id: "symlink-built-by-tar",
    attack:
      "The same symlink attack expressed through the real `tar` create path, so the corpus is not " +
      "only asserting our own header writer.",
    reason: "source_archive_unsafe_link",
    build: async (root: string) => {
      const source = join(root, "pkg");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "Cargo.toml"), '[package]\nname = "pkg"\n');
      await symlink("/etc/passwd", join(source, "passwd"));
      return tarOf(root, "pkg", "symlink-tar.tar");
    },
  },
];

/** A scratch directory per fixture, so one case cannot see another's leftovers. */
export async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `scvs-${prefix}-`));
}
