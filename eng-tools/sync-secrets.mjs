#!/usr/bin/env node
/** Writes one service's configuration into `scvs/<env>/<service>/config`; never touches a credential secret. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const targetEnv = flag("env", "dev");
const service = flag("service");
const dryRun = has("dry-run");

if (!service) {
  console.error(
    "usage: sync-secrets.mjs --env <env> --service <name> [--descriptor <json|@file>] [--dry-run]"
  );
  process.exit(2);
}

const ROOT = process.cwd();
const contractPath = flag("contract")
  ? resolve(flag("contract"))
  : join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
if (!existsSync(contractPath)) {
  console.error(`::error::no contract at config/deploy/${targetEnv}/${service}.json`);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

if (contract.kind === "batch-job-definition") {
  console.log(
    `${service} is a Batch job definition — no config secret by ADR-025 decision 1 (ADR-002). Nothing to sync.`
  );
  process.exit(0);
}

const variables = contract.secrets?.variables ?? {};
const secretName = contract.secrets?.config_secret;
if (!secretName) {
  console.error(`::error::${contractPath} declares no secrets.config_secret — nothing to write to`);
  process.exit(1);
}

function loadDescriptor() {
  const raw = flag("descriptor") ?? process.env.CI_DESCRIPTOR_JSON;
  if (!raw) return null;
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`::error::--descriptor is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}
const descriptor = loadDescriptor();

function readPath(source, path) {
  let cursor = source;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// Read before resolving: a `generate:` value is kept from the secret, or every deploy would rotate it.

const aws = (argv) =>
  execFileSync("aws", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function currentPayload() {
  try {
    const raw = aws([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secretName,
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const existing = currentPayload();

function mint(kind, name) {
  if (kind === "random-256-bit") return randomBytes(32).toString("base64");
  console.error(`::error::${name} declares generate: "${kind}", which this tool does not know how to mint`);
  process.exit(1);
}

const contractsRoot = dirname(dirname(contractPath));

function readValueFile(name, file) {
  const path = resolve(dirname(contractPath), file);
  if (isAbsolute(file) || relative(contractsRoot, path).startsWith("..")) {
    unresolved.push(`${name}: value_file "${file}" is outside the deploy contracts`);
    return undefined;
  }
  if (!existsSync(path)) {
    unresolved.push(`${name}: value_file "${file}" does not exist`);
    return undefined;
  }
  const content = readFileSync(path, "utf8");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  fromFiles.push(`${name} ← ${file} (${Buffer.byteLength(content)} bytes, sha256:${sha256})`);
  return content;
}

const payload = {};
const unresolved = [];
const skipped = [];
const minted = [];
const fromFiles = [];

for (const [name, entry] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
  if (entry.store !== "config") continue;

  // `source: image-build` is not a reason to skip: what decides is whether the contract records a value.
  // Before every other branch: the existing value keeps a generated key stable across deploys.
  if (entry.generate) {
    const kept = existing?.[name];
    payload[name] = kept ?? mint(entry.generate, name);
    if (kept === undefined) minted.push(name);
    continue;
  }

  // Before `value`: a recorded value beside a descriptor path is only a greppable name, often stale.
  if (entry.value_from_output) {
    if (!descriptor) {
      unresolved.push(`${name} needs descriptor path "${entry.value_from_output}" but none was given`);
      continue;
    }
    const value = readPath(descriptor, entry.value_from_output);
    if (value === undefined || value === null) {
      unresolved.push(
        `${name}: descriptor has no "${entry.value_from_output}" — the infrastructure may predate ` +
          `the field, or the path is wrong`
      );
      continue;
    }
    payload[name] = String(value);
    continue;
  }

  if (entry.value_file !== undefined) {
    if (entry.value !== undefined) {
      unresolved.push(`${name} declares both value and value_file`);
      continue;
    }
    const content = readValueFile(name, entry.value_file);
    if (content !== undefined) payload[name] = content;
    continue;
  }

  if (entry.value !== undefined) {
    payload[name] = String(entry.value);
    continue;
  }

  if (entry.default !== undefined) {
    skipped.push(`${name} (service default)`);
    continue;
  }

  if (entry.required) {
    unresolved.push(`${name} is required but the contract records neither a value nor a source path`);
  } else {
    skipped.push(`${name} (optional, no value)`);
  }
}

// Fail before writing anything: a partial secret would mix old and new values silently.
if (unresolved.length) {
  console.error(`✗ ${service}: ${unresolved.length} variable(s) could not be resolved`);
  for (const u of unresolved) console.error(`  ✗ ${u}`);
  console.error("\nNothing was written. Resolve these before deploying.");
  process.exit(1);
}

for (const line of fromFiles) console.log(line);

const desired = JSON.stringify(payload, Object.keys(payload).sort(), 2);

if (existing !== null) {
  const normalised = JSON.stringify(existing, Object.keys(existing).sort(), 2);
  if (normalised === desired) {
    console.log(
      `✓ ${secretName} already matches (${Object.keys(payload).length} variables) — no new version`
    );
    process.exit(0);
  }
  const before = new Set(Object.keys(existing));
  const after = new Set(Object.keys(payload));
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  const changed = [...after].filter((k) => before.has(k) && existing[k] !== payload[k]);
  console.log(`${secretName}: +${added.length} -${removed.length} ~${changed.length}`);
  // Names only, never values: this output lands in a CI log.
  for (const k of added) console.log(`  + ${k}`);
  for (const k of removed) console.log(`  - ${k}`);
  for (const k of changed) console.log(`  ~ ${k}`);
} else {
  console.log(`${secretName}: creating with ${Object.keys(payload).length} variable(s)`);
}

// Names only: a minted value never leaves this process.
if (minted.length) console.log(`  ★ minted for the first time: ${minted.join(", ")}`);
if (skipped.length) console.log(`  (${skipped.length} not written: ${skipped.join(", ")})`);

if (dryRun) {
  console.log("--dry-run: nothing written");
  process.exit(0);
}

try {
  if (existing === null) {
    aws([
      "secretsmanager",
      "create-secret",
      "--name",
      secretName,
      "--description",
      `SCVS ${service} configuration (${targetEnv}) — generated by eng-tools/sync-secrets.mjs, ADR-025`,
      "--secret-string",
      desired,
    ]);
  } else {
    aws(["secretsmanager", "put-secret-value", "--secret-id", secretName, "--secret-string", desired]);
  }
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  console.error(`::error::failed to write ${secretName}: ${detail}`);
  process.exit(1);
}

console.log(`✓ wrote ${secretName} (${Object.keys(payload).length} variables)`);
