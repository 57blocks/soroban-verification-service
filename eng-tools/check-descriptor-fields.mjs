#!/usr/bin/env node
/** Checks a live CI descriptor against every `value_from_output:` path the manifest declares. Needs `ssm:GetParameter`. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadManifest, resolveManifest, entriesOf } from "./env-manifest.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const targetEnv = flag("env", "dev");

function readDescriptor() {
  const given = flag("descriptor");
  if (given) {
    const text = given.startsWith("@") ? readFileSync(given.slice(1), "utf8") : given;
    return JSON.parse(text);
  }
  const raw = execFileSync(
    "aws",
    ["ssm", "get-parameter", "--name", `/scvs/${targetEnv}/ci/descriptor`,
     "--query", "Parameter.Value", "--output", "text"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(raw);
}

let descriptor;
try {
  descriptor = readDescriptor();
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  console.error(`::error::could not read the ${targetEnv} descriptor: ${detail}`);
  process.exit(1);
}

const readPath = (source, path) => {
  let cursor = source;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || !(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

const manifest = loadManifest(process.cwd());
const { effective, services } = resolveManifest(manifest);
const wanted = new Map();

for (const [service] of services) {
  for (const [name, entry] of effective.get(service).allowed) {
    if (!entry?.value_from_output) continue;
    if (entry.required === "forbidden" || entry.deploy === "never") continue;
    if (!wanted.has(entry.value_from_output)) wanted.set(entry.value_from_output, new Set());
    wanted.get(entry.value_from_output).add(`${service}.${name}`);
  }
}

const missing = [];
for (const [path, consumers] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
  const value = readPath(descriptor, path);
  if (value === undefined || value === null || value === "") {
    missing.push({ path, consumers: [...consumers].sort() });
  }
}

const version = descriptor.schema_version;
if (missing.length) {
  console.error(`✗ ${targetEnv} descriptor (v${version}): ${missing.length} of ${wanted.size} field(s) missing`);
  for (const { path, consumers } of missing) {
    console.error(`  ✗ ${path}  — needed by ${consumers.join(", ")}`);
  }
  console.error(
    `\nSee docs/design/ci-descriptor-v3-request.md. Until these exist, a deploy would leave those ` +
      `variables unset, which no health check would catch.`
  );
  process.exit(1);
}

console.log(`✓ ${targetEnv} descriptor (v${version}) carries all ${wanted.size} field(s) the manifest resolves from it`);
