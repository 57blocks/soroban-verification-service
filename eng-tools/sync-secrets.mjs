#!/usr/bin/env node
/**
 * Writes one service's configuration into `scvs/<env>/<service>/config` in Secrets Manager.
 *
 *   node eng-tools/sync-secrets.mjs --env dev --service query-svc [--descriptor <json>] [--dry-run]
 *
 * The write half of ADR-025: `config/deploy/<env>/<service>.json` says which variables a service gets
 * and where each value comes from; this resolves them and puts the result in the one secret CI owns.
 *
 * **It never touches a credential.** `store: "credential"` entries name pre-existing secrets
 * (`sv-<env>-rds-master-*`, `try-arweave/private-key`) that DevOps wrote and CI has no grant on — they
 * are referenced by ARN in the task definition and are not this tool's business. That separation is
 * ADR-016's blast-radius argument, which ADR-025 keeps: a grant to write a request timeout must not
 * reach a database password.
 *
 * Value resolution, in the order the manifest's `source:` implies:
 *
 *   literal       the artifact's `value` — this repository is the authority
 *   terraform     `value_from_output`, a path into the CI descriptor, resolved fresh every deploy.
 *                 No value is committed for these: an identifier carrying an account id, region, or
 *                 revision goes stale and then misleads (ADR-012 `decided: Q2`, the `infra/cdk/`
 *                 failure). That prohibition is why this indirection exists.
 *   image-build   skipped — the image supplies it
 *
 * Idempotent: it reads the current secret first and writes only on a real difference, so a redeploy
 * that changes nothing creates no new secret version. `--dry-run` prints the diff and writes nothing,
 * which is also what makes this safe to run against a live environment while developing.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

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
    "usage: sync-secrets.mjs --env <env> --service <name> [--descriptor <json|@file>] [--contract <json|@file>] [--dry-run]"
  );
  process.exit(2);
}

const contractSource = flag("contract") ? "--contract" : `config/deploy/${targetEnv}/${service}.json`;

function loadContract() {
  const explicit = flag("contract");
  if (explicit) {
    try {
      const text = explicit.startsWith("@") ? readFileSync(explicit.slice(1), "utf8") : explicit;
      return JSON.parse(text);
    } catch (error) {
      console.error(`::error::--contract is not valid JSON: ${error.message}`);
      process.exit(1);
    }
  }
  const ROOT = process.cwd();
  const contractPath = join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
  if (!existsSync(contractPath)) {
    console.error(`::error::no contract at config/deploy/${targetEnv}/${service}.json`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(contractPath, "utf8"));
}
const contract = loadContract();

if (contract.kind === "batch-job-definition") {
  // Not an oversight and not a no-op worth being quiet about: a Batch job definition keeps its
  // variables plaintext because reading a secret needs a grant ADR-002 denies its execution role.
  console.log(
    `${service} is a Batch job definition — no config secret by ADR-025 decision 1 (ADR-002). Nothing to sync.`
  );
  process.exit(0);
}

const variables = contract.secrets?.variables ?? {};
const secretName = contract.secrets?.config_secret;
if (!secretName) {
  console.error(`::error::${contractSource} declares no secrets.config_secret — nothing to write to`);
  process.exit(1);
}

// ── The descriptor ──────────────────────────────────────────────────────────────────────────────
// Passed in (the preflight job already read it) rather than read here, so one deploy reads SSM once
// and every later step sees the same document. `@path` for a file, to keep a large JSON off argv.

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

/** Reads a dotted path out of the descriptor. Returns undefined for any missing segment. */
function readPath(source, path) {
  let cursor = source;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// ── What is already there ───────────────────────────────────────────────────────────────────────
// Read before resolving, not after: a `generate:` variable resolves to the value already in the
// secret, and minting a fresh one on every deploy would rotate the key under a running service.

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
    return null; // absent, or unreadable — either way there is nothing to compare against
  }
}

const existing = currentPayload();

/**
 * A value CI mints rather than reads. `random-256-bit` is 32 bytes of CSPRNG output, base64 — the only
 * kind anything asks for so far, and an unknown kind is a hard failure rather than a guess.
 */
function mint(kind, name) {
  if (kind === "random-256-bit") return randomBytes(32).toString("base64");
  console.error(`::error::${name} declares generate: "${kind}", which this tool does not know how to mint`);
  process.exit(1);
}

// ── Resolve ─────────────────────────────────────────────────────────────────────────────────────

const payload = {};
const unresolved = [];
const skipped = [];
const minted = [];

for (const [name, entry] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
  if (entry.store !== "config") continue; // credentials are not ours to write

  // `source: image-build` is NOT a reason to skip. It says where the value came from — the image
  // ships the binary — not whether the variable is injected; STELLAR_CLI_PATH is `image-build` and
  // `inject: ecs-secrets`, and the live task definitions set it. Skipping on source dropped it from
  // the rendered definition, which would have been a silent contract change rather than a migration.
  // What decides is whether the contract records a value to write.
  // Ahead of every other branch: `generate:` and a recorded value are mutually exclusive (check:env's
  // check J refuses both), and the existing value is what keeps the key stable across deploys.
  if (entry.generate) {
    const kept = existing?.[name];
    payload[name] = kept ?? mint(entry.generate, name);
    if (kept === undefined) minted.push(name);
    continue;
  }

  if (entry.value !== undefined) {
    payload[name] = String(entry.value);
    continue;
  }

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

  if (entry.default !== undefined) {
    // The service supplies this default itself; writing it would pin a value the code owns.
    skipped.push(`${name} (service default)`);
    continue;
  }

  if (entry.required) {
    unresolved.push(`${name} is required but the contract records neither a value nor a source path`);
  } else {
    skipped.push(`${name} (optional, no value)`);
  }
}

// Fail before writing anything. A partial secret is worse than no write: the service would start with
// some variables at their old values and some at new ones, and nothing would say so.
if (unresolved.length) {
  console.error(`✗ ${service}: ${unresolved.length} variable(s) could not be resolved`);
  for (const u of unresolved) console.error(`  ✗ ${u}`);
  console.error("\nNothing was written. Resolve these before deploying.");
  process.exit(1);
}

// ── Compare, then write ─────────────────────────────────────────────────────────────────────────

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

// Names only, like the diff above — the whole point of minting here is that the value never travels.
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
