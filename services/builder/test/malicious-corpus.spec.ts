import { readdir } from "node:fs/promises";
import {
  DEFAULT_ARCHIVE_LIMITS,
  extractSourceArchive,
} from "../src/modules/builder/archive-extraction.js";
import { MALICIOUS_ARCHIVES, scratch } from "./malicious-corpus.js";

const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 8, maxUncompressedBytes: 1024 * 1024 };

describe("T5 — every adversarial archive fails closed, with its documented reason", () => {
  it.each(MALICIOUS_ARCHIVES.map((entry) => [entry.id, entry] as const))(
    "%s",
    async (_id, entry) => {
      const root = await scratch("corpus-src");
      const dest = await scratch("corpus-dest");
      const archive = await entry.build(root);

      const result = await extractSourceArchive({ archivePath: archive, destRoot: dest, limits });

      expect({ id: entry.id, ok: result.ok }).toEqual({ id: entry.id, ok: false });
      if (result.ok) return;
      expect({ id: entry.id, reason: result.reason }).toEqual({ id: entry.id, reason: entry.reason });

      expect(await readdir(dest)).toEqual([]);
    },
  );

  it("covers every attack family the README reserved this corpus for", () => {
    const reasons = new Set(MALICIOUS_ARCHIVES.map((entry) => entry.reason));

    expect(reasons).toContain("source_archive_unsafe_path");
    expect(reasons).toContain("source_archive_unsafe_link");
    expect(reasons).toContain("source_archive_too_many_entries");
    expect(reasons).toContain("source_archive_too_large_uncompressed");
    expect(reasons).toContain("source_archive_conflicting_entries");
  });

  it("has no duplicate ids, since the id is what a failure names", () => {
    const ids = MALICIOUS_ARCHIVES.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every attack family in both container formats", () => {
    const families = ["unsafe_path", "unsafe_link", "too_many_entries", "too_large_uncompressed"];
    const zipReasons = new Set(
      MALICIOUS_ARCHIVES.filter((entry) => entry.id.startsWith("zip-")).map((entry) => entry.reason),
    );

    for (const family of families) {
      expect(zipReasons).toContain(`source_archive_${family}`);
    }
  });
});

describe("T5 — the corpus is not vacuously red", () => {
  it("★ admits a conformant zip through the same call", async () => {
    const root = await scratch("corpus-zip-src");
    const dest = await scratch("corpus-zip-dest");
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { zipArchive } = await import("./malicious-corpus.js");

    const archive = join(root, "clean.zip");
    await writeFile(
      archive,
      zipArchive([
        { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
        { name: "pkg/src/lib.rs", body: "pub fn hello() {}\n" },
      ]),
    );

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest, limits });

    expect(result.ok).toBe(true);
    expect((await readdir(dest)).sort()).toEqual(["Cargo.toml", "src"]);
  });

  it("★ admits a conformant archive through the same call", async () => {
    const root = await scratch("corpus-ok-src");
    const dest = await scratch("corpus-ok-dest");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { runCommand } = await import("@scvs/core/process");

    const source = join(root, "pkg");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "Cargo.toml"), '[package]\nname = "pkg"\n');
    await writeFile(join(source, "src", "lib.rs"), "pub fn hello() {}\n");
    const archive = join(root, "clean.tar");
    await runCommand(["tar", "-cf", archive, "-C", root, "pkg"], { mirrorOutput: false });

    const result = await extractSourceArchive({ archivePath: archive, destRoot: dest, limits });

    expect(result.ok).toBe(true);
    expect((await readdir(dest)).sort()).toEqual(["Cargo.toml", "src"]);
  });
});
