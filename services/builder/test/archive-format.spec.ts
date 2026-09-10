import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  alignArchiveNameForCli,
  hasCliAcceptedArchiveSuffix,
  sniffArchiveFormat,
} from "../src/modules/builder/archive-format.js";
import { materializeSource } from "../src/modules/builder/fetch-source.js";

/**
 * `stellar contract verify` decides an archive's format from its **name**, and that name was the submitter's
 * `x-filename` header carried through the staging key and the presigned URL's path into `--source-uri`.
 */
describe("sniffArchiveFormat", () => {
  it("reads the format from the magic number, not the name", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-archive-format-"));

    const gzip = join(root, "source");
    await writeFile(gzip, gzipSync(Buffer.from("contents")));
    expect(await sniffArchiveFormat(gzip)).toBe("gzip");

    const zip = join(root, "source.tar.gz");
    await writeFile(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    // A zip *named* `.tar.gz` — the name is accepted and the format is still read off the bytes.
    expect(await sniffArchiveFormat(zip)).toBe("zip");

    const tar = join(root, "source.tar");
    await writeFile(tar, tarBytes());
    expect(await sniffArchiveFormat(tar)).toBe("tar");

    const text = join(root, "notes.txt");
    await writeFile(text, "not an archive\n");
    expect(await sniffArchiveFormat(text)).toBe("unknown");

    // Unreadable is `unknown`, not a throw: this decides what to *name* a file, and a read failure is the
    // byte-level checks' business (`archive-extraction.ts`), not this one's.
    expect(await sniffArchiveFormat(join(root, "absent"))).toBe("unknown");
    expect(await sniffArchiveFormat(root)).toBe("unknown");
  });

  it("accepts exactly the three suffixes the CLI names, case-insensitively", () => {
    expect(hasCliAcceptedArchiveSuffix("/tmp/x/source.tar.gz")).toBe(true);
    expect(hasCliAcceptedArchiveSuffix("/tmp/x/source.TGZ")).toBe(true);
    expect(hasCliAcceptedArchiveSuffix("/tmp/x/source.zip")).toBe(true);
    // `.tar` is a real archive our own extractor handles and one the CLI has no accepted name for.
    expect(hasCliAcceptedArchiveSuffix("/tmp/x/source.tar")).toBe(false);
    expect(hasCliAcceptedArchiveSuffix("/tmp/x/source")).toBe(false);
    expect(hasCliAcceptedArchiveSuffix("/tmp/x/source.gz")).toBe(false);
  });
});

describe("alignArchiveNameForCli", () => {
  it("gives a badly-named gzip an accepted name without touching its bytes or its original path", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-archive-align-"));
    const artifactRoot = join(root, "artifacts");
    const original = join(root, "counter-contract");
    const bytes = gzipSync(Buffer.from("source archive contents"));
    await writeFile(original, bytes);

    const aligned = await alignArchiveNameForCli({ localPath: original, artifactRoot });

    expect(aligned.format).toBe("gzip");
    expect(aligned.alignment).toBe("linked");
    expect(basename(aligned.path)).toBe("counter-contract.tar.gz");
    expect(hasCliAcceptedArchiveSuffix(aligned.path)).toBe(true);
    // Byte-identical, and the same inode rather than a second copy.
    expect(await readFile(aligned.path)).toEqual(bytes);
    expect((await stat(aligned.path)).ino).toBe((await stat(original)).ino);
    expect(await readFile(original)).toEqual(bytes);
  });

  it("leaves an already-acceptable name alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-archive-align-ok-"));
    const original = join(root, "source.tgz");
    await writeFile(original, gzipSync(Buffer.from("x")));

    const aligned = await alignArchiveNameForCli({ localPath: original, artifactRoot: join(root, "artifacts") });

    expect(aligned).toEqual({ path: original, format: "gzip", alignment: "already_accepted" });
  });

  it("invents no name for a bare tar, because a repack would change the hashed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-archive-align-tar-"));
    const original = join(root, "source.tar");
    await writeFile(original, tarBytes());

    const aligned = await alignArchiveNameForCli({ localPath: original, artifactRoot: join(root, "artifacts") });

    expect(aligned).toEqual({ path: original, format: "tar", alignment: "no_accepted_name" });
  });
});

describe("materializeSource — the name the CLI is handed", () => {
  it("publishes an accepted name for a correctly-hashed archive that was badly named", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-materialize-name-"));
    const artifactDir = join(root, "artifacts");
    // The staging case: `x-filename: counter-contract` on the upload, so the presigned URL's path — and then
    // the local file — carried a name with no extension at all.
    const path = join(root, "counter-contract");
    const bytes = gzipSync(Buffer.from("source archive contents"));
    await writeFile(path, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const result = await materializeSource({
      sourceRef: { type: "source_uri", visibility: "public", source_uri: path, source_sha256: sha256 },
      config: { artifactDir },
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hasCliAcceptedArchiveSuffix(result.source.source_uri!)).toBe(true);
    expect(result.source.workspace_path).toBe(result.source.source_uri);
    // It is also what the CLI re-checks against the contract's recorded `source_sha256`, which is why nothing
    // may repack.
    expect(result.source.source_sha256).toBe(sha256);
    expect(await readFile(result.source.source_uri!)).toEqual(bytes);
  });

  it("still rejects a hash mismatch before any renaming happens", async () => {
    const root = await mkdtemp(join(tmpdir(), "scvs-materialize-mismatch-"));
    const path = join(root, "counter-contract");
    await writeFile(path, gzipSync(Buffer.from("source archive contents")));

    const result = await materializeSource({
      sourceRef: { type: "source_uri", visibility: "public", source_uri: path, source_sha256: "c".repeat(64) },
      config: { artifactDir: join(root, "artifacts") },
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_sha256_mismatch");
  });
});

/** A minimal tar member header: `ustar` at offset 257 is what identifies the format. */
function tarBytes(): Buffer {
  const block = Buffer.alloc(512);
  block.write("source/Cargo.toml", 0, "latin1");
  block.write("ustar", 257, "latin1");
  return block;
}
