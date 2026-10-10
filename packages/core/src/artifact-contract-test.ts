// Must load before any decorated class is evaluated.
import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_SCHEMA_UNSUPPORTED,
  ARTIFACT_UNREADABLE,
  BUILD_ARTIFACT_SCHEMA_VERSION,
  PRE_VERSIONED_BUILD_ARTIFACT_SCHEMA_VERSION,
  probeBuildArtifactDocument,
} from "./artifact-contract.js";
import { deriveArtifactContractSnapshot, type ArtifactContractSnapshot } from "./artifact-contract-snapshot.js";
import { BuildArtifact } from "./batch.js";
import { parseSchemaVersion } from "./validators/schema-version.js";
import { safeParseDto, flattenValidationErrors } from "./validate.js";

const update = process.argv.includes("--update");
const CONTRACT_DIR = new URL("../contract/", import.meta.url).pathname;
const CORPUS_DIR = join(CONTRACT_DIR, "corpus");

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function snapshotPath(version: string): string {
  return join(CONTRACT_DIR, `build-artifact.v${version}.json`);
}

function frozenVersions(): string[] {
  return readdirSync(CONTRACT_DIR)
    .map((name) => /^build-artifact\.v(\d+\.\d+)\.json$/.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .sort(compareVersions);
}

function compareVersions(left: string, right: string): number {
  const a = parseSchemaVersion(left);
  const b = parseSchemaVersion(right);
  assert.ok(a && b, `both ${left} and ${right} must be MAJOR.MINOR`);
  return a.major - b.major || a.minor - b.minor;
}

function corpusVersions(): string[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/^v/, ""))
    .sort(compareVersions);
}

function corpusDocuments(version: string): Array<{ name: string; text: string }> {
  const dir = join(CORPUS_DIR, `v${version}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name: `v${version}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

test("every corpus document, at every version, parses under the current contract", () => {
  const versions = corpusVersions();
  assert.ok(versions.includes(PRE_VERSIONED_BUILD_ARTIFACT_SCHEMA_VERSION), "the pre-versioning corpus must exist");
  assert.ok(versions.includes(BUILD_ARTIFACT_SCHEMA_VERSION), "the current version needs a corpus");

  let parsed = 0;
  for (const version of versions) {
    const documents = corpusDocuments(version);
    assert.ok(documents.length > 0, `corpus v${version} is empty`);
    for (const { name, text } of documents) {
      const probe = probeBuildArtifactDocument(text);
      assert.equal(probe.kind, "readable", `${name} must be readable, got ${probe.kind}`);
      if (probe.kind !== "readable") continue;
      assert.equal(
        probe.declared,
        version,
        `${name} declares ${probe.declared} but sits in the v${version} corpus`,
      );
      const validated = safeParseDto(BuildArtifact, probe.document);
      assert.ok(
        validated.success,
        `${name} no longer validates: ${validated.success ? "" : flattenValidationErrors(validated.errors).map((i) => i.property).join(", ")}`,
      );
      parsed += 1;
    }
  }
  console.log(`  (${parsed} documents across ${versions.length} versions)`);
});

test("a document from a builder ahead of this reader is unsupported, not invalid", () => {
  const ahead = probeBuildArtifactDocument(JSON.stringify({ schema_version: "2.0" }));
  assert.equal(ahead.kind, "unsupported");
  assert.equal(ahead.kind === "unsupported" && ahead.supported, BUILD_ARTIFACT_SCHEMA_VERSION);

  const minor = probeBuildArtifactDocument(JSON.stringify({ schema_version: "1.7" }));
  assert.equal(minor.kind, "readable");

  const absent = probeBuildArtifactDocument(JSON.stringify({}));
  assert.equal(absent.kind, "readable");
  assert.equal(absent.kind === "readable" && absent.declared, PRE_VERSIONED_BUILD_ARTIFACT_SCHEMA_VERSION);
});

test("bytes that are not a versioned artifact are unreadable, and say why without echoing them", () => {
  for (const text of ["", "not json", "[]", '"a string"', '{"schema_version": 1}', '{"schema_version": "1"}']) {
    const probe = probeBuildArtifactDocument(text);
    assert.equal(probe.kind, "unreadable", `${JSON.stringify(text)} must be unreadable`);
  }
  const long = probeBuildArtifactDocument(JSON.stringify({ schema_version: "9".repeat(4096) }));
  assert.equal(long.kind, "unreadable");
  assert.ok(long.kind === "unreadable" && long.detail.length < 128, "the detail must not carry the sandbox's bytes");
});

test("the two terminal error codes are the ones the orchestrator records", () => {
  assert.equal(ARTIFACT_SCHEMA_UNSUPPORTED, "artifact_schema_unsupported");
  assert.equal(ARTIFACT_UNREADABLE, "artifact_unreadable");
});

test("the current version's snapshot describes the contract as it is now", () => {
  const derived = deriveArtifactContractSnapshot();
  const path = snapshotPath(BUILD_ARTIFACT_SCHEMA_VERSION);
  if (update) {
    writeFileSync(path, `${JSON.stringify(derived, null, 2)}\n`);
    console.log(`  (wrote ${path})`);
    return;
  }
  let frozen: ArtifactContractSnapshot;
  try {
    frozen = JSON.parse(readFileSync(path, "utf8")) as ArtifactContractSnapshot;
  } catch {
    assert.fail(
      `no snapshot for schema_version ${BUILD_ARTIFACT_SCHEMA_VERSION}. If you just bumped it, run ` +
        "`pnpm run generate:contract-snapshot` and commit the new file — the diff is how review sees " +
        "the wire change.",
    );
  }
  assert.deepEqual(
    derived,
    frozen,
    `the builder↔orchestrator wire contract no longer matches ${path}. Any change to it is a version ` +
      "change: bump BUILD_ARTIFACT_SCHEMA_VERSION (MINOR for a new optional field, MAJOR for anything " +
      "an older reader could reject, including widening an @IsIn) and run " +
      "`pnpm run generate:contract-snapshot`. Editing this file without bumping is the one thing " +
      "review must refuse — see rules 24 and 25 of docs/invariants.md.",
  );
});

test("no frozen version lost a shape, a property, or its tolerance of an absent one", () => {
  const derived = deriveArtifactContractSnapshot();
  const versions = frozenVersions();
  assert.ok(versions.length > 0, "at least one frozen snapshot must exist");
  assert.equal(
    versions[versions.length - 1],
    BUILD_ARTIFACT_SCHEMA_VERSION,
    "BUILD_ARTIFACT_SCHEMA_VERSION must be the newest frozen snapshot",
  );

  const breaks: string[] = [];
  for (const version of versions) {
    if (version === BUILD_ARTIFACT_SCHEMA_VERSION && update) continue;
    const frozen = JSON.parse(readFileSync(snapshotPath(version), "utf8")) as ArtifactContractSnapshot;
    for (const [shape, { properties }] of Object.entries(frozen.shapes)) {
      const now = derived.shapes[shape];
      if (now === undefined) {
        breaks.push(`v${version} names shape ${shape}, which the contract no longer reaches`);
        continue;
      }
      for (const [property, was] of Object.entries(properties)) {
        const is = now.properties[property];
        if (is === undefined) {
          breaks.push(`v${version}'s ${shape}.${property} was deleted`);
          continue;
        }
        if (is.absence_rejected && !was.absence_rejected) {
          breaks.push(`${shape}.${property} was tolerated when absent in v${version} and is now rejected`);
        }
        if (was.nested !== undefined && is.nested !== was.nested) {
          breaks.push(`${shape}.${property} nested ${was.nested} in v${version} and now nests ${is.nested}`);
        }
      }
    }
  }
  assert.deepEqual(
    breaks,
    [],
    "the contract broke a version an orchestrator may still be running. Rule 24 of docs/invariants.md " +
      "makes this permanent: only additive or relaxing changes are allowed. A genuinely breaking change needs a " +
      "MAJOR bump plus a dual-write transition, and the old version's snapshot is deleted only once no " +
      "deployed orchestrator reads it.",
  );
});

console.log("artifact contract: corpus, probe and snapshot checks passed");
