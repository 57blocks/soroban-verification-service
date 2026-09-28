import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  archiveReaderFor,
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_EXTRACTION_OPTIONS,
  extractSourceArchive,
  formatExtractionNormalisation,
  MAX_UNWRAP_DEPTH,
  stripDepthFor,
  totalUncompressedBytes,
} from "../src/modules/builder/archive-extraction.js";
import { runCommand } from "@scvs/core/process";
import { zipArchive } from "./malicious-corpus.js";

describe("extractSourceArchive", () => {
  it("strips the top-level directory and normalises modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-src-"));
    const source = join(root, "pkg");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
    await writeFile(join(source, "src", "lib.rs"), "pub fn hello() {}\n");
    await chmod(join(source, "Cargo.toml"), 0o777);
    await chmod(join(source, "src"), 0o777);
    const archive = await tarFixture(root, "pkg");
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result).toEqual({
      ok: true,
      source_root: dest,
      normalisation: DEFAULT_EXTRACTION_OPTIONS,
    });
    expect(modeOf(await stat(join(dest, "Cargo.toml")))).toBe("0644");
    expect(modeOf(await stat(join(dest, "src")))).toBe("0755");
    expect(modeOf(await stat(join(dest, "src", "lib.rs")))).toBe("0644");
    expect(formatExtractionNormalisation(DEFAULT_EXTRACTION_OPTIONS)).toBe("file=0644,dir=0755,strip=1");
  });

  it("refuses an archive containing symlinks before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-link-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
    try {
      await symlink("Cargo.toml", join(source, "Cargo-link.toml"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const archive = await tarFixture(root, "pkg");
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-link-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_archive_unsafe_link");
      expect(result.detail).toContain("link");
    }
  });

  it("rejects a traversal entry in an archive whose name has no archive extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-rename-"));
    const traversal = await traversalFixture(root, "not-an-archive.bin");
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-rename-dest-"));

    const result = await extractSourceArchive({ archivePath: traversal, destRoot: dest });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_archive_unsafe_path");
  });

  it("rejects an archive with more entries than the limit allows", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-entries-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    for (let i = 0; i < 12; i += 1) await writeFile(join(source, `f${i}.txt`), "x");
    const archive = await tarFixture(root, "pkg");
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-entries-dest-"));

    const result = await extractSourceArchive({
      archivePath: archive,
      destRoot: dest,
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 5 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_archive_too_many_entries");
      expect(result.detail).toContain("5");
    }
  });

  it("rejects an archive that expands past the uncompressed bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-size-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "big.txt"), "x".repeat(4096));
    const archive = await tarFixture(root, "pkg");
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-size-dest-"));

    const result = await extractSourceArchive({
      archivePath: archive,
      destRoot: dest,
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxUncompressedBytes: 1024 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_archive_too_large_uncompressed");
      expect(result.detail).toContain("1024");
    }
  });

  it("extracts a zip with the same stripping and mode normalisation as a tar", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-zip-"));
    const archive = join(root, "source.zip");
    await writeFile(
      archive,
      zipArchive([
        { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n', mode: 0o100777 },
        { name: "pkg/src/lib.rs", body: "pub fn hello() {}\n" },
      ]),
    );
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-zip-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result).toEqual({
      ok: true,
      source_root: dest,
      normalisation: DEFAULT_EXTRACTION_OPTIONS,
    });
    expect(modeOf(await stat(join(dest, "Cargo.toml")))).toBe("0644");
    expect(modeOf(await stat(join(dest, "src")))).toBe("0755");
    expect(modeOf(await stat(join(dest, "src", "lib.rs")))).toBe("0644");
  });

  it("reads the uncompressed bound off a zip listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-zipsize-"));
    const archive = join(root, "big.zip");
    await writeFile(archive, zipArchive([{ name: "pkg/big.bin", body: "0".repeat(64 * 1024) }]));
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-zipsize-dest-"));

    const result = await extractSourceArchive({
      archivePath: archive,
      destRoot: dest,
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxUncompressedBytes: 1024 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_archive_too_large_uncompressed");
      expect(result.detail).toContain(String(64 * 1024));
    }
  });

  it("names a missing reader as an infrastructure fault, not a bad archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-noreader-"));
    const archive = join(root, "source.zip");
    await writeFile(archive, zipArchive([{ name: "pkg/Cargo.toml", body: "x\n" }]));
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-noreader-dest-"));

    const path = process.env.PATH;
    process.env.PATH = join(root, "no-binaries-here");
    try {
      const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("source_archive_reader_unavailable");
        expect(result.detail).toContain("bsdtar");
        expect(result.detail).toContain("not the problem");
      }
    } finally {
      process.env.PATH = path;
    }
  });

  it("routes each detected format to the reader that can read it", () => {
    expect(archiveReaderFor("zip")).toBe("bsdtar");
    expect(archiveReaderFor("gzip")).toBe("tar");
    expect(archiveReaderFor("tar")).toBe("tar");
    expect(archiveReaderFor("unknown")).toBe("tar");
  });

  it("unwraps a source archive that was compressed a second time (.tar.gz.zip)", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-nested-"));
    const source = join(root, "pkg");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "Cargo.toml"), '[package]\nname = "pkg"\n');
    await writeFile(join(source, "src", "lib.rs"), "pub fn hello() {}\n");
    await chmod(join(source, "Cargo.toml"), 0o777);
    const inner = await tarGzFixture(root, "pkg", "counter.tar.gz");
    const archive = join(root, "counter.tar.gz.zip");
    await writeFile(archive, zipArchive([{ name: "counter.tar.gz", body: await latin1(inner) }]));
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-nested-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result).toEqual({
      ok: true,
      source_root: dest,
      normalisation: DEFAULT_EXTRACTION_OPTIONS,
      canonicalisation: {
        depth: 1,
        outer_format: "zip",
        canonical_format: "gzip",
        peeled: [{ member: "counter.tar.gz", format: "zip" }],
      },
    });
    expect((await readdir(dest)).sort()).toEqual(["Cargo.toml", "src"]);
    expect(modeOf(await stat(join(dest, "Cargo.toml")))).toBe("0644");
    expect(modeOf(await stat(join(dest, "src", "lib.rs")))).toBe("0644");
    const siblings = await readdir(dirname(dest));
    expect(siblings.filter((entry) => entry.startsWith(`${basename(dest)}-peel-`))).toEqual([]);
  });

  it("unwraps through a Finder zip's AppleDouble droppings", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-finder-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const inner = await tarGzFixture(root, "pkg", "counter.tar.gz");
    const archive = join(root, "counter.tar.gz.zip");
    await writeFile(
      archive,
      zipArchive([
        { name: "counter.tar.gz", body: await latin1(inner) },
        { name: "__MACOSX/._counter.tar.gz", body: "Mac OS X resource fork\n" },
        { name: ".DS_Store", body: "\u0000\u0001Bud1\n" },
      ]),
    );
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-finder-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(true);
    expect(await readdir(dest)).toEqual(["Cargo.toml"]);
  });

  it("still refuses an unsafe path hidden in a wrapper's droppings", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-nested-unsafe-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
    const inner = await tarGzFixture(root, "pkg", "counter.tar.gz");
    const archive = join(root, "counter.tar.gz.zip");
    await writeFile(
      archive,
      zipArchive([
        { name: "counter.tar.gz", body: await latin1(inner) },
        { name: "pkg/../../._evil", body: "escaped\n" },
      ]),
    );
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-nested-unsafe-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_archive_unsafe_path");
  });

  it("refuses a container whose single member is not an archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-nested-plain-"));
    const archive = join(root, "source.zip");
    await writeFile(archive, zipArchive([{ name: "lib.rs", body: "pub fn hello() {}\n" }]));
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-nested-plain-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_archive_nested_unsupported");
      expect(result.detail).toContain("lib.rs");
      expect(result.detail).toContain(".tar.gz");
    }
  });

  it("follows a chain of wrappers up to the depth bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-chain-ok-"));
    const archive = await wrapperChain(root, MAX_UNWRAP_DEPTH);
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-chain-ok-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(true);
    expect(await readdir(dest)).toEqual(["Cargo.toml"]);
    if (result.ok) {
      expect(result.canonicalisation?.depth).toBe(MAX_UNWRAP_DEPTH);
      expect(result.canonicalisation?.outer_format).toBe("gzip");
      expect(result.canonicalisation?.canonical_format).toBe("gzip");
    }
  });

  it("refuses a chain of wrappers deeper than the bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-nested-deep-"));
    const archive = await wrapperChain(root, MAX_UNWRAP_DEPTH + 1);
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-nested-deep-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_archive_nested_too_deep");
      expect(result.detail).toContain(String(MAX_UNWRAP_DEPTH));
    }
  });

  it("reads a zip nested inside a zip", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-zip-in-zip-"));
    const innerZip = join(root, "counter.zip");
    await writeFile(innerZip, zipArchive([{ name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' }]));
    const archive = join(root, "counter.zip.zip");
    await writeFile(archive, zipArchive([{ name: "counter.zip", body: await latin1(innerZip) }]));
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-zip-in-zip-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(true);
    expect(await readdir(dest)).toEqual(["Cargo.toml"]);
    if (result.ok) expect(result.canonicalisation?.canonical_format).toBe("zip");
  });

  it("keeps a flat source tree that has no wrapping directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-flat-"));
    const archive = join(root, "source.zip");
    await writeFile(
      archive,
      zipArchive([
        { name: "Cargo.toml", body: '[package]\nname = "pkg"\n' },
        { name: "src/lib.rs", body: "pub fn hello() {}\n" },
      ]),
    );
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-flat-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalisation.stripComponents).toBe(0);
    expect((await readdir(dest)).sort()).toEqual(["Cargo.toml", "src"]);
    expect(await readdir(join(dest, "src"))).toEqual(["lib.rs"]);
  });

  it("charges the unwrapped member against the inner archive's uncompressed bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-nested-budget-"));
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "big.bin"), "0".repeat(64 * 1024));
    const inner = await tarGzFixture(root, "pkg", "counter.tar.gz");
    const innerBytes = (await stat(inner)).size;
    const archive = join(root, "counter.tar.gz.zip");
    await writeFile(archive, zipArchive([{ name: "counter.tar.gz", body: await latin1(inner) }]));
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-nested-budget-dest-"));

    const result = await extractSourceArchive({
      archivePath: archive,
      destRoot: dest,
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxUncompressedBytes: innerBytes + 1024 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_archive_too_large_uncompressed");
  });

  it("admits an archive that fits both bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-fits-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
    const archive = await tarFixture(root, "pkg");
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-fits-dest-"));

    const result = await extractSourceArchive({
      archivePath: archive,
      destRoot: dest,
      limits: { maxEntries: 10, maxUncompressedBytes: 1024 * 1024 },
    });

    expect(result.ok).toBe(true);
  });
});

describe("totalUncompressedBytes", () => {
  const GNU = [
    "drwxr-xr-x owner/group     0 2026-08-11 05:27 sub/",
    "-rw-r--r-- owner/group    27 2026-08-11 05:27 sub/file.txt",
    "-rw-r--r-- owner/group   163 2026-08-11 05:27 sub/other.txt",
  ].join("\n");

  const BSD = [
    "drwxr-xr-x  0 owner group       0 Aug 11 13:27 sub/",
    "-rw-r--r--  0 owner group      27 Aug 11 13:27 sub/file.txt",
    "-rw-r--r--  0 owner group     163 Aug 11 13:27 sub/other.txt",
  ].join("\n");

  it("reads GNU tar's layout", () => {
    expect(totalUncompressedBytes(GNU)).toEqual({ ok: true, bytes: 190 });
  });

  it("reads bsdtar's layout", () => {
    expect(totalUncompressedBytes(BSD)).toEqual({ ok: true, bytes: 190 });
  });

  it("agrees across both layouts", () => {
    expect(totalUncompressedBytes(GNU)).toEqual(totalUncompressedBytes(BSD));
  });

  it("is not fooled by a month name in the owner field", () => {
    const bsd = "-rw-r--r--  0 Jan    wheel 10485760 Aug  6 15:06 pkg/big.bin";
    const gnu = "-rw-r--r-- 0 Aug 0/g      1000 2026-08-11 05:27 src/lib.rs";

    expect(totalUncompressedBytes(bsd)).toEqual({ ok: true, bytes: 10485760 });
    expect(totalUncompressedBytes(gnu)).toEqual({ ok: true, bytes: 1000 });
  });

  it("reads a file whose name is itself a month", () => {
    expect(totalUncompressedBytes("-rw-r--r-- owner/group    27 2026-08-11 05:27 Aug")).toEqual({
      ok: true,
      bytes: 27,
    });
  });

  it("reads bsdtar's year form, which replaces the time on old entries", () => {
    expect(totalUncompressedBytes("-rw-r--r--  0 owner group  27 Aug 11  2025 f.txt")).toEqual({
      ok: true,
      bytes: 27,
    });
  });

  it("reports a line it cannot read rather than skipping it", () => {
    const result = totalUncompressedBytes("-rw-r--r-- owner/group ??? not-a-date file.txt");
    expect(result.ok).toBe(false);
  });

  it("matches what the local tar actually prints", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-size-live-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "a.txt"), "x".repeat(100));
    await writeFile(join(source, "b.txt"), "y".repeat(250));
    const archive = await tarFixture(root, "pkg");

    // LC_ALL pinned: a non-English locale changes tar's date column.
    const listing = await runCommand(["tar", "-tvf", archive], {
      mirrorOutput: false,
      env: { LC_ALL: "C" },
    });
    const parsed = totalUncompressedBytes(listing.stdout);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bytes).toBe(350);
  });

  const hasZhCnLocale = (() => {
    try {
      return execFileSync("locale", ["-a"], { encoding: "utf8" })
        .split("\n")
        .some((line) => line.trim().toLowerCase() === "zh_cn.utf-8");
    } catch {
      return false;
    }
  })();

  (hasZhCnLocale ? it : it.skip)(
    "is not fooled by a numeric-month listing under a non-English LC_TIME (zh_CN)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "scvs-extract-locale-"));
      const source = join(root, "pkg");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
      const archive = await tarFixture(root, "pkg");

      const unpinned = await runCommand([archiveReaderFor("tar"), "-tvf", archive], {
        mirrorOutput: false,
        env: { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" },
      });
      expect(totalUncompressedBytes(unpinned.stdout).ok).toBe(false);

      const previousLang = process.env.LANG;
      const previousLcAll = process.env.LC_ALL;
      process.env.LANG = "zh_CN.UTF-8";
      process.env.LC_ALL = "zh_CN.UTF-8";
      try {
        const dest = await mkdtemp(join(tmpdir(), "scvs-extract-locale-dest-"));
        const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });
        expect(result.ok).toBe(true);
      } finally {
        if (previousLang === undefined) delete process.env.LANG;
        else process.env.LANG = previousLang;
        if (previousLcAll === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = previousLcAll;
      }
    }
  );
});

async function tarGzFixture(root: string, entry: string, name: string): Promise<string> {
  const archive = join(root, name);
  const result = await runCommand(["tar", "-czf", archive, "-C", root, entry], { mirrorOutput: false });
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || result.error || "tar.gz fixture failed");
  }
  return archive;
}

describe("archive bounds at the exact boundary", () => {
  const ENTRIES = 6;

  it("admits exactly `maxEntries` materialised entries and refuses one more", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-entry-boundary-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
    for (let i = 0; i < ENTRIES - 1; i += 1) await writeFile(join(source, `f${i}.txt`), "x");
    const archive = await tarFixture(root, "pkg");

    const atLimit = await extractSourceArchive({
      archivePath: archive,
      destRoot: await mkdtemp(join(tmpdir(), "scvs-extract-entry-at-")),
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: ENTRIES },
    });
    expect(atLimit.ok).toBe(true);

    const overLimit = await extractSourceArchive({
      archivePath: archive,
      destRoot: await mkdtemp(join(tmpdir(), "scvs-extract-entry-over-")),
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: ENTRIES - 1 },
    });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.reason).toBe("source_archive_too_many_entries");
      expect(overLimit.detail).toContain(String(ENTRIES - 1));
    }
  });

  it("admits a declared expansion equal to `maxUncompressedBytes` and refuses one byte more", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-size-boundary-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    const body = "x".repeat(4096);
    await writeFile(join(source, "big.txt"), body);
    const archive = await tarFixture(root, "pkg");

    // LC_ALL pinned: a non-English locale changes tar's date column.
    const listing = await runCommand([archiveReaderFor("tar"), "-tvf", archive], {
      mirrorOutput: false,
      env: { LC_ALL: "C" },
    });
    expect(listing.exit_code).toBe(0);
    const declared = totalUncompressedBytes(listing.stdout);
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(declared.bytes).toBeGreaterThanOrEqual(body.length);

    const atLimit = await extractSourceArchive({
      archivePath: archive,
      destRoot: await mkdtemp(join(tmpdir(), "scvs-extract-size-at-")),
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxUncompressedBytes: declared.bytes },
    });
    expect(atLimit.ok).toBe(true);

    const overLimit = await extractSourceArchive({
      archivePath: archive,
      destRoot: await mkdtemp(join(tmpdir(), "scvs-extract-size-over-")),
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxUncompressedBytes: declared.bytes - 1 },
    });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.reason).toBe("source_archive_too_large_uncompressed");
      expect(overLimit.detail).toContain(String(declared.bytes - 1));
    }
  });
});

async function wrapperChain(root: string, peels: number): Promise<string> {
  await mkdir(join(root, "pkg"), { recursive: true });
  await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
  let entry = "pkg";
  let archive = "";
  for (let level = 0; level <= peels; level += 1) {
    const name = `w${level}.tar.gz`;
    archive = await tarGzFixture(root, entry, name);
    entry = name;
  }
  return archive;
}

describe("the archive is listed once, not twice", () => {
  async function countReaderCalls(build: (root: string) => Promise<string>): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), "scvs-listing-count-"));
    const archive = await build(root);
    const binDir = join(root, "bin");
    const log = join(root, "calls.log");
    await mkdir(binDir, { recursive: true });
    for (const name of ["tar", "bsdtar"]) {
      const real = (await runCommand(["sh", "-c", `command -v ${name} || true`], { mirrorOutput: false })).stdout.trim();
      if (!real) continue;
      await writeFile(
        join(binDir, name),
        `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$1" >> ${JSON.stringify(log)}\nexec ${real} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const dest = await mkdtemp(join(tmpdir(), "scvs-listing-count-dest-"));
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath}`;
    try {
      const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });
      expect(result.ok).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
    return (await readFile(log, "utf8")).split("\n").filter(Boolean);
  }

  it("reads one -tf and one -tvf for an ordinary source archive", async () => {
    const calls = await countReaderCalls(async (root) => {
      await mkdir(join(root, "pkg"), { recursive: true });
      await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
      return tarGzFixture(root, "pkg", "counter.tar.gz");
    });

    expect(calls.filter((call) => call.endsWith(" -tf"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith(" -tvf"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith(" -xf"))).toHaveLength(1);
  });

  it("reads one -tf per level for a peeled archive, and none twice", async () => {
    const calls = await countReaderCalls(async (root) => {
      await mkdir(join(root, "pkg"), { recursive: true });
      await writeFile(join(root, "pkg", "Cargo.toml"), '[package]\nname = "pkg"\n');
      const inner = await tarGzFixture(root, "pkg", "counter.tar.gz");
      const archive = join(root, "counter.tar.gz.zip");
      await writeFile(archive, zipArchive([{ name: "counter.tar.gz", body: await latin1(inner) }]));
      return archive;
    });

    expect(calls.filter((call) => call.endsWith(" -tf"))).toHaveLength(2);
  });
});

describe("stripDepthFor", () => {
  it("strips one level when every entry shares a top-level directory", () => {
    expect(stripDepthFor("pkg/\npkg/Cargo.toml\npkg/src/\npkg/src/lib.rs\n")).toBe(1);
    expect(stripDepthFor("./pkg/Cargo.toml\n./pkg/src/lib.rs\n")).toBe(1);
  });

  it("strips nothing when a file sits at the root", () => {
    expect(stripDepthFor("Cargo.toml\nsrc/\nsrc/lib.rs\n")).toBe(0);
  });

  it("strips nothing when there are two top-level directories", () => {
    expect(stripDepthFor("a/\na/Cargo.toml\nb/\nb/Cargo.toml\n")).toBe(0);
  });

  it("does not let a Finder dropping look like a second top-level directory", () => {
    expect(stripDepthFor("pkg/\npkg/Cargo.toml\n__MACOSX/\n__MACOSX/._Cargo.toml\n.DS_Store\n")).toBe(1);
  });

  it("answers 0 for an empty listing rather than stripping a level that is not there", () => {
    expect(stripDepthFor("")).toBe(0);
  });
});

async function latin1(path: string): Promise<string> {
  return (await readFile(path)).toString("latin1");
}

async function tarFixture(root: string, entry: string): Promise<string> {
  const archive = join(root, "source.tar");
  const result = await runCommand(["tar", "-cf", archive, "-C", root, entry], { mirrorOutput: false });
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || result.error || "tar fixture failed");
  }
  return archive;
}

async function traversalFixture(root: string, name = "traversal.bin"): Promise<string> {
  const archive = join(root, name);
  await writeFile(archive, ustarArchive("../escape.txt", "escaped\n"));
  return archive;
}

function ustarArchive(memberName: string, body: string): Buffer {
  const header = Buffer.alloc(512, 0);
  const write = (value: string, offset: number, length: number) =>
    header.write(value.padEnd(length, "\0").slice(0, length), offset, "binary");
  const octal = (value: number, offset: number, length: number) =>
    write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);

  write(memberName, 0, 100);
  octal(0o644, 100, 8);          // mode
  octal(0, 108, 8);              // uid
  octal(0, 116, 8);              // gid
  octal(body.length, 124, 12);   // size
  octal(0, 136, 12);             // mtime
  write("        ", 148, 8);     // checksum placeholder: spaces, per the format
  write("0", 156, 1);            // type: regular file
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  write("root", 265, 32);        // uname
  write("root", 297, 32);        // gname

  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);

  const content = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  content.write(body, 0, "binary");
  // Two zero blocks terminate the archive.
  return Buffer.concat([header, content, Buffer.alloc(1024, 0)]);
}

function modeOf(info: { mode: number }): string {
  return (info.mode & 0o777).toString(8).padStart(4, "0");
}
