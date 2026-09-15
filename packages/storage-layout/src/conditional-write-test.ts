import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResultStorage } from "./storage-backend.js";

const JSON_TYPE = "application/json; charset=utf-8";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "conditional-write-test-"));
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: "https://example.test" });

  // The filesystem backend reaches only as far as this process, and says so rather than leaving the limit to
  // a document nothing can check.
  assert.equal(storage.crossProcessAtomicWrites, false);

  // Of the object backends only S3 has been run against this code; R2 must not inherit the claim on the
  // strength of sharing an API. (A field initialiser here would read `kind` before the constructor assigns
  // it and report false for both, so the flag is worth asserting on a real instance.)
  const objectStorage = (kind: "s3" | "r2") =>
    createResultStorage({ kind, bucket: "b", publicRoot: "https://example.test", client: {} as never });
  assert.equal(objectStorage("s3").crossProcessAtomicWrites, true);
  assert.equal(objectStorage("r2").crossProcessAtomicWrites, false);

  // Absent object: no version to read, and only a create-if-absent write may land.
  assert.equal(await storage.readTextVersioned("wasms/a.json"), undefined);
  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "first\n", JSON_TYPE, null), "written");

  // Create-if-absent against something that now exists is a conflict, and writes nothing.
  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "clobber\n", JSON_TYPE, null), "conflict");
  assert.equal(await readFile(join(root, "wasms/a.json"), "utf8"), "first\n");

  // A version read back pins a successful replacement.
  const read = await storage.readTextVersioned("wasms/a.json");
  assert.ok(read);
  assert.equal(read.text, "first\n");
  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "second\n", JSON_TYPE, read.version), "written");

  // The now-stale version is refused, and the bytes on disk are untouched.
  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "third\n", JSON_TYPE, read.version), "conflict");
  assert.equal(await readFile(join(root, "wasms/a.json"), "utf8"), "second\n");

  // Unparseable bytes still carry a version: a body we cannot read is NOT an absent object, and a
  // create-if-absent write must not be able to replace it.
  await storage.writeText("wasms/b.json", "{ not json", JSON_TYPE);
  const corrupt = await storage.readTextVersioned("wasms/b.json");
  assert.ok(corrupt, "a corrupt document must still report a version");
  assert.equal(await storage.writeTextIfUnchanged("wasms/b.json", "{}\n", JSON_TYPE, null), "conflict");
  assert.equal(await readFile(join(root, "wasms/b.json"), "utf8"), "{ not json");

  // Two writers pinned to the SAME version, launched concurrently rather than one after the other: the
  // compare and the rename are several await points apart, so without serialisation both would pass the
  // compare and the loser's bytes would silently replace the winner's.
  await storage.writeTextIfUnchanged("wasms/c.json", "base\n", JSON_TYPE, null);
  const pinned = await storage.readTextVersioned("wasms/c.json");
  assert.ok(pinned);
  const raced = await Promise.all([
    storage.writeTextIfUnchanged("wasms/c.json", "left\n", JSON_TYPE, pinned.version),
    storage.writeTextIfUnchanged("wasms/c.json", "right\n", JSON_TYPE, pinned.version),
  ]);
  assert.deepEqual([...raced].sort(), ["conflict", "written"], "exactly one racer may land");
  const landed = await readFile(join(root, "wasms/c.json"), "utf8");
  assert.ok(landed === "left\n" || landed === "right\n", "the winner's bytes, whole");

  // Create-if-absent races the same way: two writers both seeing an absent object must not both land.
  const created = await Promise.all([
    storage.writeTextIfUnchanged("wasms/d.json", "first\n", JSON_TYPE, null),
    storage.writeTextIfUnchanged("wasms/d.json", "second\n", JSON_TYPE, null),
  ]);
  assert.deepEqual([...created].sort(), ["conflict", "written"], "exactly one creator may land");

  console.log(
    "Conditional writes: version pinning, create-if-absent, stale refusal, corrupt-is-not-absent, " +
      "and two concurrent racers resolving to exactly one winner passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
