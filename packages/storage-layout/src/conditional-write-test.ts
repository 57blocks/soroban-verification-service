import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResultStorage } from "./storage-backend.js";

const JSON_TYPE = "application/json; charset=utf-8";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "conditional-write-test-"));
  const storage = createResultStorage({ kind: "filesystem", root, publicRoot: "https://example.test" });

  assert.equal(storage.crossProcessAtomicWrites, false);

  const objectStorage = (config: Partial<Parameters<typeof createResultStorage>[0]>) =>
    createResultStorage({ kind: "s3", bucket: "b", publicRoot: "https://example.test", ...config } as never);
  assert.equal(objectStorage({}).crossProcessAtomicWrites, true);
  assert.equal(objectStorage({ kind: "r2" }).crossProcessAtomicWrites, false);
  assert.equal(
    objectStorage({ endpoint: "https://account.r2.cloudflarestorage.com" }).crossProcessAtomicWrites,
    false,
    "an s3-shaped config aimed at another endpoint claims nothing",
  );
  assert.equal(
    objectStorage({ client: {} as never }).crossProcessAtomicWrites,
    false,
    "an injected client is opaque — its endpoint cannot be read back from here",
  );

  assert.equal(await storage.readTextVersioned("wasms/a.json"), undefined);
  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "first\n", JSON_TYPE, null), "written");

  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "clobber\n", JSON_TYPE, null), "conflict");
  assert.equal(await readFile(join(root, "wasms/a.json"), "utf8"), "first\n");

  const read = await storage.readTextVersioned("wasms/a.json");
  assert.ok(read);
  assert.equal(read.text, "first\n");
  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "second\n", JSON_TYPE, read.version), "written");

  assert.equal(await storage.writeTextIfUnchanged("wasms/a.json", "third\n", JSON_TYPE, read.version), "conflict");
  assert.equal(await readFile(join(root, "wasms/a.json"), "utf8"), "second\n");

  await storage.writeText("wasms/b.json", "{ not json", JSON_TYPE);
  const corrupt = await storage.readTextVersioned("wasms/b.json");
  assert.ok(corrupt, "a corrupt document must still report a version");
  assert.equal(await storage.writeTextIfUnchanged("wasms/b.json", "{}\n", JSON_TYPE, null), "conflict");
  assert.equal(await readFile(join(root, "wasms/b.json"), "utf8"), "{ not json");

  // Must run concurrently: sequential writes never reach the interleaving.
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

  const created = await Promise.all([
    storage.writeTextIfUnchanged("wasms/d.json", "first\n", JSON_TYPE, null),
    storage.writeTextIfUnchanged("wasms/d.json", "second\n", JSON_TYPE, null),
  ]);
  assert.deepEqual([...created].sort(), ["conflict", "written"], "exactly one creator may land");

  // Realpath'd first: macOS reaches its temp dir through a symlink, which the lock does not unify.
  {
    const previous = process.cwd();
    const realRoot = await realpath(root);
    process.chdir(realRoot);
    try {
      const absolute = createResultStorage({ kind: "filesystem", root: realRoot, publicRoot: "https://example.test" });
      const relative = createResultStorage({ kind: "filesystem", root: ".", publicRoot: "https://example.test" });
      await absolute.writeTextIfUnchanged("wasms/e.json", "base\n", JSON_TYPE, null);
      const pin = (await absolute.readTextVersioned("wasms/e.json"))!.version;
      const spelled = await Promise.all([
        absolute.writeTextIfUnchanged("wasms/e.json", "abs\n", JSON_TYPE, pin),
        relative.writeTextIfUnchanged("wasms/e.json", "rel\n", JSON_TYPE, pin),
      ]);
      assert.deepEqual([...spelled].sort(), ["conflict", "written"], "one root spelled two ways is one lock");
    } finally {
      process.chdir(previous);
    }
  }

  console.log(
    "Conditional writes: version pinning, create-if-absent, stale refusal, corrupt-is-not-absent, " +
      "two concurrent racers resolving to exactly one winner, and one lock per resolved root passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
