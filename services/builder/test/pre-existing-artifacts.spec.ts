import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { snapshotWasmPaths } from "../src/modules/builder/artifact-selection.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "scvs-ar2-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, contents = "\0asm"): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  return resolve(path);
}

describe("snapshotWasmPaths", () => {
  it("finds a planted artifact at the path a build tool would write its own output to", () => {
    return write("target/wasm32v1-none/release/hello_world.wasm").then(async (planted) => {
      expect(await snapshotWasmPaths(root)).toEqual(new Set([planted]));
    });
  });

  it("finds artifacts at any depth, and only Wasm", async () => {
    const nested = await write("contracts/a/deep/artifact.wasm");
    const top = await write("shipped.wasm");
    await write("README.md", "not a wasm");
    await write("target/release/build.rs", "fn main() {}");

    expect(await snapshotWasmPaths(root)).toEqual(new Set([nested, top]));
  });

  it("returns an empty set for a conformant archive, which ships no build output", async () => {
    await write("src/lib.rs", "pub fn hello() {}");
    await write("Cargo.toml", "[package]");

    expect(await snapshotWasmPaths(root)).toEqual(new Set());
  });

  it("does not follow symlinks out of the tree", async () => {
    const outside = await mkdtemp(join(tmpdir(), "scvs-ar2-outside-"));
    try {
      await writeFile(join(outside, "elsewhere.wasm"), "\0asm");
      await symlink(join(outside, "elsewhere.wasm"), join(root, "link.wasm"));

      expect(await snapshotWasmPaths(root)).toEqual(new Set());
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips .git and node_modules, which no build reads and both of which can be huge", async () => {
    await write(".git/objects/pack/planted.wasm");
    await write("node_modules/dep/planted.wasm");
    const real = await write("target/release/real.wasm");

    expect(await snapshotWasmPaths(root)).toEqual(new Set([real]));
  });

  it("survives an unreadable directory rather than failing the verification", async () => {
    await expect(snapshotWasmPaths(join(root, "does-not-exist"))).resolves.toEqual(new Set());
  });
});
