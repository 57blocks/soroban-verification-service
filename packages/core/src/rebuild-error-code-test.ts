import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  rebuildErrorCodeClass,
  rebuildErrorCodeClasses,
  rebuildErrorCodes,
  isRebuildErrorCode,
  classifyRebuildErrorCode,
  type RebuildErrorCodeClass,
} from "./rebuild-error-code.js";

// `--update` writes the snapshot instead of asserting it.
const update = process.argv.includes("--update");
const SNAPSHOT = new URL("../contract/rebuild-error-codes.json", import.meta.url).pathname;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

type Snapshot = { codes: Record<string, RebuildErrorCodeClass> };

function derive(): Snapshot {
  return {
    codes: Object.fromEntries(rebuildErrorCodes.map((code) => [code, rebuildErrorCodeClass[code]])),
  };
}

if (update) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(derive(), null, 2)}\n`);
  console.log(`wrote ${SNAPSHOT}`);
}

// ── The guarantee: neither end of the Batch seam can change this vocabulary invisibly ──────────────
// The sandbox writes these codes into `BuildArtifact.reason`; `rebuildFailureReason` reads the class and
// decides retryability. A code added, renamed or reclassified shows up here as a reviewable diff.
test("the vocabulary and its classes match the frozen snapshot", () => {
  const frozen = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  const current = derive();

  const added = Object.keys(current.codes).filter((code) => frozen.codes[code] === undefined);
  const removed = Object.keys(frozen.codes).filter((code) => current.codes[code] === undefined);
  const reclassified = Object.keys(current.codes)
    .filter((code) => frozen.codes[code] !== undefined && frozen.codes[code] !== current.codes[code])
    .map((code) => `${code}: ${frozen.codes[code]} -> ${current.codes[code]}`);

  assert.deepEqual(
    { added, removed, reclassified },
    { added: [], removed: [], reclassified: [] },
    "run `pnpm run generate:error-code-snapshot` and put the diff in the PR — a reclassification changes " +
      "whether a failure is retried",
  );
  console.log(`  (${rebuildErrorCodes.length} codes)`);
});

test("every code carries a known class, and the table is the only vocabulary", () => {
  for (const code of rebuildErrorCodes) {
    assert.ok(
      (rebuildErrorCodeClasses as readonly string[]).includes(rebuildErrorCodeClass[code]),
      `${code} has an unknown class`,
    );
    assert.ok(isRebuildErrorCode(code), `${code} must pass its own guard`);
    assert.equal(classifyRebuildErrorCode(code), rebuildErrorCodeClass[code]);
  }
  assert.equal(new Set(rebuildErrorCodes).size, rebuildErrorCodes.length, "no duplicate codes");
});

// An older sandbox, or a `docker_error` passed through in the code's place, is not a parse failure: the
// caller falls back rather than throwing, and `rebuildFailureReason` still has a rung for it.
test("an unknown code classifies as undefined rather than throwing", () => {
  assert.equal(classifyRebuildErrorCode("a_code_no_build_of_this_knows"), undefined);
  assert.equal(classifyRebuildErrorCode(undefined), undefined);
  assert.equal(classifyRebuildErrorCode(null), undefined);
  assert.equal(classifyRebuildErrorCode(""), undefined);
  assert.equal(isRebuildErrorCode("Cannot connect to the Docker daemon"), false);
});
