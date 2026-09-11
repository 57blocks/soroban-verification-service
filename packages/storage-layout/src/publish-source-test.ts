import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishSource } from "./publish.js";
import { sourceKey, sourceKeyFromFileName } from "./keys.js";
import { createResultStorage } from "./storage-backend.js";

const SOURCE_SHA256 = "b".repeat(64);

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "scvs-publish-source-test-"));
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: "http://localhost/public" });

  // sourceKey: exact key shape, plural prefix matching reportKey's reports/.
  assert.equal(sourceKey(SOURCE_SHA256, ".tar.gz"), `sources/${SOURCE_SHA256}.tar.gz`);
  assert.equal(sourceKey(SOURCE_SHA256, ".zip"), `sources/${SOURCE_SHA256}.zip`);

  // Writes binary bytes losslessly — the whole point of writeBytes existing separately from writeText (a
  // utf8-encoding round trip would corrupt arbitrary binary content).
  const original = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0xc0, 0xde, 0xad, 0xbe, 0xef]);
  await publishSource(storage, {
    sourceSha256: SOURCE_SHA256,
    bytes: original,
    extension: ".tar.gz",
    contentType: "application/octet-stream",
  });
  const readBack = await storage.readBytes(sourceKey(SOURCE_SHA256, ".tar.gz"));
  assert.ok(readBack, "expected sources/<sha>.tar.gz to exist after publishSource");
  assert.deepEqual(Array.from(readBack), Array.from(original));

  // Idempotent: re-publishing the same sha256+extension overwrites at the same key rather than erroring or
  // accumulating — a retry after a partial failure must be safe with no pre-check.
  const replacement = new Uint8Array([1, 2, 3, 4, 5]);
  await publishSource(storage, {
    sourceSha256: SOURCE_SHA256,
    bytes: replacement,
    extension: ".tar.gz",
    contentType: "application/octet-stream",
  });
  const readBackAfterOverwrite = await storage.readBytes(sourceKey(SOURCE_SHA256, ".tar.gz"));
  assert.ok(readBackAfterOverwrite);
  assert.deepEqual(Array.from(readBackAfterOverwrite), Array.from(replacement));

  // A different extension for the SAME sha256 is a genuinely different key — not the same object, no collision
  // with the .tar.gz written above.
  await publishSource(storage, {
    sourceSha256: SOURCE_SHA256,
    bytes: replacement,
    extension: ".zip",
    contentType: "application/octet-stream",
  });
  const zipReadBack = await storage.readBytes(sourceKey(SOURCE_SHA256, ".zip"));
  assert.ok(zipReadBack);
  assert.deepEqual(Array.from(zipReadBack), Array.from(replacement));
  const tarGzStillThere = await storage.readBytes(sourceKey(SOURCE_SHA256, ".tar.gz"));
  assert.ok(tarGzStillThere, "the earlier .tar.gz write must be unaffected by the .zip write");

  // Reading a hash that was never published resolves undefined, not an error.
  const neverPublished = "c".repeat(64);
  assert.equal(await storage.readBytes(sourceKey(neverPublished, ".tar.gz")), undefined);

  // exists: no-content-transfer presence check, the skip-if-already-published guard multiple jobs declaring the
  // same public source rely on.
  assert.equal(await storage.exists(sourceKey(SOURCE_SHA256, ".tar.gz")), true);
  assert.equal(await storage.exists(sourceKey(neverPublished, ".tar.gz")), false);

  // sourceKeyFromFileName: same key as sourceKey(sha256, extension), from the already-assembled
  // {sha256}{extension} shape VerificationArtifact.source.source_file_name carries.
  assert.equal(sourceKeyFromFileName(`${SOURCE_SHA256}.tar.gz`), sourceKey(SOURCE_SHA256, ".tar.gz"));
  assert.equal(await storage.exists(sourceKeyFromFileName(`${SOURCE_SHA256}.tar.gz`)), true);

  console.log("publish-source-test: all assertions passed");
}

main();
