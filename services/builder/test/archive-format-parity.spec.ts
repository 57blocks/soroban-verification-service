import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES, uploadArchiveFormat } from "@scvs/core";
import {
  archiveReaderFor,
  extractSourceArchive,
} from "../src/modules/builder/archive-extraction.js";
import {
  CLI_ACCEPTED_ARCHIVE_SUFFIXES,
  sniffArchiveFormat,
  type ArchiveFormat,
} from "../src/modules/builder/archive-format.js";
import { ustarArchive, zipArchive } from "./malicious-corpus.js";

type FormatRow = {
  format: Exclude<ArchiveFormat, "unknown">;
  bytes: () => Buffer;
  cliAccepts: boolean;
  weExtract: boolean;
  doorAdmits: boolean;
  consoleSuffix: string;
};

const CLEAN_MEMBERS = [
  { name: "pkg/Cargo.toml", body: '[package]\nname = "pkg"\n' },
  { name: "pkg/src/lib.rs", body: "pub fn hello() {}\n" },
];

const ROWS: readonly FormatRow[] = [
  {
    format: "gzip",
    bytes: () => gzipSync(ustarArchive(CLEAN_MEMBERS)),
    cliAccepts: true,
    weExtract: true,
    doorAdmits: true,
    consoleSuffix: ".tar.gz",
  },
  {
    format: "zip",
    bytes: () => zipArchive(CLEAN_MEMBERS),
    cliAccepts: true,
    weExtract: true,
    doorAdmits: true,
    consoleSuffix: ".zip",
  },
  {
    format: "tar",
    bytes: () => ustarArchive(CLEAN_MEMBERS),
    cliAccepts: false,
    weExtract: true,
    doorAdmits: false,
    consoleSuffix: ".tar",
  },
];

describe("archive format parity — the CLI, this extractor, the upload door and the console", () => {
  it.each(ROWS.map((row) => [row.format, row] as const))(
    "%s: the sniffer, the reader and the CLI's suffix rule agree",
    async (_format, row) => {
      const root = await mkdtemp(join(tmpdir(), `scvs-parity-${row.format}-`));
      const archive = join(root, "source.bin");
      await writeFile(archive, row.bytes());

      expect(await sniffArchiveFormat(archive)).toBe(row.format);

      const hasAcceptedName = CLI_ACCEPTED_ARCHIVE_SUFFIXES.some(
        (suffix) => row.consoleSuffix === suffix,
      );
      expect(hasAcceptedName).toBe(row.cliAccepts);

      const dest = await mkdtemp(join(tmpdir(), `scvs-parity-${row.format}-dest-`));
      const result = await extractSourceArchive({ archivePath: archive, destRoot: dest });
      expect({ format: row.format, extracted: result.ok }).toEqual({
        format: row.format,
        extracted: row.weExtract,
      });

      expect({ format: row.format, admitted: !!uploadArchiveFormat(row.bytes()) }).toEqual({
        format: row.format,
        admitted: row.doorAdmits,
      });
    },
  );

  it("offers exactly the formats the upload door admits", () => {
    const accept = consoleAcceptList();

    for (const row of ROWS) {
      expect({ format: row.format, offered: accept.includes(row.consoleSuffix) }).toEqual({
        format: row.format,
        offered: row.doorAdmits,
      });
    }
  });

  it("offers the door's suffixes and no others", () => {
    const offered = consoleAcceptList().filter((entry) => entry.startsWith("."));

    expect(offered.sort()).toEqual([...ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES].sort());
  });

  it("has no format the console offers that the build path cannot read", () => {
    const offered = consoleAcceptList().filter((entry) => entry.startsWith("."));
    const readable = ROWS.filter((row) => row.weExtract).map((row) => row.consoleSuffix);
    const alias: Record<string, string> = { ".tgz": ".tar.gz", ".gz": ".tar.gz" };

    const unreadable = offered.filter((entry) => !readable.includes(alias[entry] ?? entry));

    expect(unreadable).toEqual([]);
  });

  it("routes every format to a reader", () => {
    for (const row of ROWS) {
      expect(archiveReaderFor(row.format)).toBeTruthy();
    }
    expect(archiveReaderFor("unknown")).toBe("tar");
  });
});

function consoleAcceptList(): string[] {
  const path = join(
    repoRoot(),
    "clients",
    "web",
    "src",
    "features",
    "verification",
    "constants.ts",
  );
  const source = readFileSync(path, "utf8");
  const match = source.match(/sourceArchiveAccept\s*=\s*\n?\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`Could not read sourceArchiveAccept from ${path}`);
  }
  return match[1].split(",").map((entry) => entry.trim());
}

function repoRoot(): string {
  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate repository root");
    current = parent;
  }
}
