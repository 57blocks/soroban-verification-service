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
import { runCommand } from "../src/modules/builder/process-utils.js";
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

  /** 0.2. The extension is now nothing the validator consults. */
  it("rejects a traversal entry in an archive whose name has no archive extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-rename-"));
    // `.bin`, so the deleted gate — /\.(tar|tar\.gz|tgz)$/i over a submitter-chosen filename — would have
    // skipped every check for this archive.
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

  /** The console offers `.zip` and `stellar contract verify` accepts it, so a zip could take the verify path. */
  it("extracts a zip with the same stripping and mode normalisation as a tar", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-zip-"));
    const archive = join(root, "source.zip");
    await writeFile(
      archive,
      zipArchive([
        // 0o777 in the archive, so the mode assertions below are about *our* normalisation rather than about
        // what the writer happened to record.
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

  /** The bound has to hold on the zip listing too. */
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
      // The declared size, not the ~100-byte compressed one — proving the listing was parsed rather than the
      // file stat'ed.
      expect(result.detail).toContain(String(64 * 1024));
    }
  });

  /** A missing reader is the verifier's fault, and gets a reason code that says so. */
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
    // `unknown` staying on tar is the clause that bounds the change: bzip2/xz/zstd carry no magic number the
    // sniffer knows, and work today only via GNU tar's own auto-detection.
    expect(archiveReaderFor("zip")).toBe("bsdtar");
    expect(archiveReaderFor("gzip")).toBe("tar");
    expect(archiveReaderFor("tar")).toBe("tar");
    expect(archiveReaderFor("unknown")).toBe("tar");
  });

  /** A submitter who compresses an archive again — a macOS Finder "Compress", a mail client, a browser download. */
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
      // What the peel found, which is also what reaches the handoff and decides which archive the verify path
      // hands the CLI.
      canonicalisation: {
        depth: 1,
        outer_format: "zip",
        canonical_format: "gzip",
        peeled: [{ member: "counter.tar.gz", format: "zip" }],
      },
    });
    // The inner archive's top-level directory is what got stripped — the outer container's member never becomes
    // a path in the build tree.
    expect((await readdir(dest)).sort()).toEqual(["Cargo.toml", "src"]);
    expect(modeOf(await stat(join(dest, "Cargo.toml")))).toBe("0644");
    expect(modeOf(await stat(join(dest, "src", "lib.rs")))).toBe("0644");
    // Nothing left behind: the peel stages into a sibling of destRoot, and a second copy of the submitter's
    // bytes must not survive in the handoff.
    const siblings = await readdir(dirname(dest));
    expect(siblings.filter((entry) => entry.startsWith(`${basename(dest)}-peel-`))).toEqual([]);
  });

  /**
   * The likeliest way a `.tar.gz` ends up inside a `.zip` at all is macOS Finder's "Compress", which writes an
   * AppleDouble sidecar next to the file it was asked to compress.
   */
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
    // The droppings were skipped for *recognising* the shape, and never became part of the tree.
    expect(await readdir(dest)).toEqual(["Cargo.toml"]);
  });

  /**
   * Every line of the outer listing still goes through `validateArchiveEntries`, so a traversal hidden under a
   * name the predicate skips is refused before the unwrap writes anything.
   */
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
        // A dropping-shaped *basename* (`._`) carrying a traversal, rather than something under `__MACOSX/`,
        // and the choice is about being platform-independent.
        { name: "pkg/../../._evil", body: "escaped\n" },
      ]),
    );
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-nested-unsafe-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_archive_unsafe_path");
  });

  /**
   * The refusal half, and the reason it has its own code: "we unwrapped one level and what was inside is not a
   * source archive" is a fact the submitter can act on in one step.
   */
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
      // Names what to submit instead, rather than only what was wrong.
      expect(result.detail).toContain(".tar.gz");
    }
  });

  /**
   * A chain, followed rather than refused at the first level: a submitter who compresses an already compressed
   * archive twice is doing nothing a single compression does not already do.
   */
  it("follows a chain of wrappers up to the depth bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-chain-ok-"));
    const archive = await wrapperChain(root, MAX_UNWRAP_DEPTH);
    const dest = await mkdtemp(join(tmpdir(), "scvs-extract-chain-ok-dest-"));

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });

    expect(result.ok).toBe(true);
    // The real source tree came out, not an intermediate archive.
    expect(await readdir(dest)).toEqual(["Cargo.toml"]);
    if (result.ok) {
      expect(result.canonicalisation?.depth).toBe(MAX_UNWRAP_DEPTH);
      expect(result.canonicalisation?.outer_format).toBe("gzip");
      expect(result.canonicalisation?.canonical_format).toBe("gzip");
    }
  });

  /**
   * The bound bounds *work*, not bytes — `maxUncompressedBytes` is charged down the chain and is what bounds
   * expansion (see the budget case above).
   */
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

  /**
   * A zip whose single member is a zip was refused outright before, on the argument that "each level is bounded
   * on its own, so N levels are bounded by nothing".
   */
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

  /**
   * A fixed `--strip-components 1` deletes `Cargo.toml` outright and lifts `src/lib.rs` to `lib.rs`, then
   * reports a layout problem about a source tree that is fine.
   */
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

  /**
   * The inner archive is charged for what the unwrap already wrote, so a chain cannot spend the uncompressed
   * ceiling once per level.
   */
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
      // Enough for the wrapper's member, and — because that spend is charged — not enough for the 64 KiB the
      // inner archive then declares.
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

/**
 * The size column sits at a different field index in each tar, so these are the two layouts the bound has to
 * survive.
 */
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

  /**
   * `uname` and `gname` are attacker-chosen strings printed before the size, so an archive built with
   * `--uname=Jan` puts a month-shaped token in front of the real date.
   */
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

    // Pinned so this test's intent — does the parser read a real tar listing — doesn't depend on whatever
    // locale this machine happens to run under.
    const listing = await runCommand(["tar", "-tvf", archive], {
      mirrorOutput: false,
      env: { LC_ALL: "C" },
    });
    const parsed = totalUncompressedBytes(listing.stdout);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bytes).toBe(350);
  });

  // A non-English `LC_TIME` (confirmed for zh_CN) makes BSD tar print a numeric month in `-tvf`'s date column
  // (e.g. "9  9 13:52" instead of "Sep  9 13:52"), which `timestampIndex` cannot read — and must not be taught
  // to, since a lenient numeric-month match would let a crafted `--uname`/`--gname` plus a size chosen to look
  // like a 4-digit year forge an earlier false timestamp match, misreading the real size and defeating the
  // fail-closed `maxUncompressedBytes` check. This only reproduces if the machine has the locale installed to
  // prove it with.
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

      // Confirms the fixture actually reproduces the failure this locale causes: unpinned, this listing is
      // unparseable.
      const unpinned = await runCommand([archiveReaderFor("tar"), "-tvf", archive], {
        mirrorOutput: false,
        env: { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" },
      });
      expect(totalUncompressedBytes(unpinned.stdout).ok).toBe(false);

      // `extractSourceArchive` pins the reader's own locale internally, so it must succeed even when the
      // calling process's environment is the one that reproduces the failure above.
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

/** A real gzipped tar, for the nested cases. */
async function tarGzFixture(root: string, entry: string, name: string): Promise<string> {
  const archive = join(root, name);
  const result = await runCommand(["tar", "-czf", archive, "-C", root, entry], { mirrorOutput: false });
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || result.error || "tar.gz fixture failed");
  }
  return archive;
}

/** The two numeric bounds, checked from **both** sides of the boundary. */
describe("archive bounds at the exact boundary", () => {
  /** Small enough to be free, large enough that an off-by-one is not hidden by a rounding accident. */
  const ENTRIES = 6;

  it("admits exactly `maxEntries` materialised entries and refuses one more", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-extract-entry-boundary-"));
    const source = join(root, "pkg");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "Cargo.toml"), "[package]\nname = \"pkg\"\n");
    // `pkg/` itself strips to nothing under `--strip-components 1` and is not counted, so the materialised
    // total is exactly the number of files.
    for (let i = 0; i < ENTRIES - 1; i += 1) await writeFile(join(source, `f${i}.txt`), "x");
    const archive = await tarFixture(root, "pkg");

    const atLimit = await extractSourceArchive({
      archivePath: archive,
      destRoot: await mkdtemp(join(tmpdir(), "scvs-extract-entry-at-")),
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: ENTRIES },
    });
    // The negative control. Without it, `maxEntries: ENTRIES - 1` refusing proves only that something refuses
    // things.
    expect(atLimit.ok).toBe(true);

    const overLimit = await extractSourceArchive({
      archivePath: archive,
      destRoot: await mkdtemp(join(tmpdir(), "scvs-extract-entry-over-")),
      limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: ENTRIES - 1 },
    });
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.reason).toBe("source_archive_too_many_entries");
      // The bound, not the count: a submitter who cannot see the limit cannot act on the refusal.
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

    // Read off the listing rather than assumed from `body.length`: `totalUncompressedBytes` sums *every* line,
    // and whether the `pkg/` directory contributes a zero is the tar's business, not this test's. Pinned so a
    // non-English locale can't turn this listing itself into a false negative unrelated to what's under test.
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
    // `>` and not `>=` in the implementation, which is the whole distinction this row exists for.
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

/** A source archive wrapped `peels` times: `pkg/Cargo.toml` -> `w0.tar.gz` -> `w1.tar.gz` -> … */
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

/**
 * Splitting `extractSourceArchive` into a peel and an extraction gave each its own `tar -tf`, so every
 * submission paid one full listing more than before the split.
 */
describe("the archive is listed once, not twice", () => {
  async function countReaderCalls(build: (root: string) => Promise<string>): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), "scvs-listing-count-"));
    const archive = await build(root);
    const binDir = join(root, "bin");
    const log = join(root, "calls.log");
    await mkdir(binDir, { recursive: true });
    // `tar` and `bsdtar` both, since the reader is chosen from the bytes.
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

    // One listing for the peel-and-validate decision, one verbose pass for the link and size checks, one
    // extraction.
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

    // The container and the archive inside it: one listing each, and the inner one is reused by the extraction
    // rather than read a third time.
    expect(calls.filter((call) => call.endsWith(" -tf"))).toHaveLength(2);
  });
});

describe("stripDepthFor", () => {
  it("strips one level when every entry shares a top-level directory", () => {
    expect(stripDepthFor("pkg/\npkg/Cargo.toml\npkg/src/\npkg/src/lib.rs\n")).toBe(1);
    // GNU tar's `./`-prefixed listing is the same archive.
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

/** A file's bytes in the byte-preserving encoding `zipArchive` reads its member bodies as. */
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

/** An archive holding `../escape.txt`, written byte by byte rather than produced by `tar`. */
async function traversalFixture(root: string, name = "traversal.bin"): Promise<string> {
  const archive = join(root, name);
  await writeFile(archive, ustarArchive("../escape.txt", "escaped\n"));
  return archive;
}

/** A single-member ustar archive. Enough of the format for the listing to be real. */
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
