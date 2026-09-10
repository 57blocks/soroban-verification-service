import assert from "node:assert/strict";
import { extractManifestPath, resolveContainerManifestPath } from "./manifest-path.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("extractManifestPath: reads both spellings the reference emits", () => {
  assert.equal(extractManifestPath(["--manifest-path=contracts/a/Cargo.toml"]), "contracts/a/Cargo.toml");
  assert.equal(extractManifestPath(["--manifest-path", "contracts/b/Cargo.toml"]), "contracts/b/Cargo.toml");
});

test("extractManifestPath: returns undefined when the recipe records none", () => {
  assert.equal(extractManifestPath([]), undefined);
  assert.equal(extractManifestPath(undefined), undefined);
  assert.equal(extractManifestPath(["-p", "contract-a", "--meta", "k=v"]), undefined);
});

test("extractManifestPath: unescapes the recorded value like every other bldopt reader", () => {
  // `bldopt` entries are shell-escaped (BE4) — reading them raw would corrupt any quoted path.
  assert.equal(
    extractManifestPath(["--manifest-path='contracts/with space/Cargo.toml'"]),
    "contracts/with space/Cargo.toml",
  );
  const quotedEscape = extractManifestPath(["--manifest-path='../../etc/Cargo.toml'"]);
  assert.equal(quotedEscape, "../../etc/Cargo.toml");
  const containment = resolveContainerManifestPath(quotedEscape!);
  assert.equal(containment.ok, false);
  assert.equal(!containment.ok && containment.reason, "manifest_path_escapes_source");
});

test("extractManifestPath: a trailing bare flag with no following value yields undefined, not a crash", () => {
  assert.equal(extractManifestPath(["--manifest-path"]), undefined);
});

test("resolveContainerManifestPath: maps a relative manifest under the mount, normalised", () => {
  assert.deepEqual(resolveContainerManifestPath("contracts/a/Cargo.toml"), {
    ok: true,
    path: "/source/contracts/a/Cargo.toml",
  });
  // A directory is completed to its Cargo.toml.
  assert.deepEqual(resolveContainerManifestPath("contracts/a"), {
    ok: true,
    path: "/source/contracts/a/Cargo.toml",
  });
  assert.deepEqual(resolveContainerManifestPath("."), { ok: true, path: "/source/Cargo.toml" });
  assert.deepEqual(resolveContainerManifestPath(""), { ok: true, path: "/source/Cargo.toml" });
});

test("resolveContainerManifestPath: refuses an absolute path", () => {
  const result = resolveContainerManifestPath("/tmp/scvs-src-abc/Cargo.toml");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "absolute_manifest_path_not_supported");
});

test("resolveContainerManifestPath: refuses a path that escapes the mount, rather than clamping it", () => {
  // Clamping would build *something* for a recipe that asked for something else — a wrong verdict rather than a
  // failure.
  for (const escape of ["../Cargo.toml", "../../etc/Cargo.toml", "contracts/../../outside/Cargo.toml", ".."]) {
    const result = resolveContainerManifestPath(escape);
    assert.equal(result.ok, false, `expected ${JSON.stringify(escape)} to be refused`);
    assert.equal(!result.ok && result.reason, "manifest_path_escapes_source");
  }
});

test("resolveContainerManifestPath: allows a `..` that stays inside the tree, because the check is on the outcome", () => {
  // `a/../b` normalises to `b`. Refusing on the spelling would reject a legitimate recorded value.
  assert.deepEqual(resolveContainerManifestPath("contracts/../packages/x/Cargo.toml"), {
    ok: true,
    path: "/source/packages/x/Cargo.toml",
  });
});

console.log("manifest-path: all cases passed");
