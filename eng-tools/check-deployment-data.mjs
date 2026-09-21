#!/usr/bin/env node
/**
 * Refuses a literal reference to one deployment's data. This repository holds the SHAPE of the
 * deployment contract (`config/env-manifest.yaml`, `config/deploy/_EXAMPLE/`); the values belong to
 * whoever runs a deployment, and reach the pipeline as an argument and the container as its own
 * configuration.
 *
 * Two regressions this exists to stop, both of which passed every other gate:
 *   - a tool resolving `config/deploy/<env>/<service>.json` from its own tree, which cannot be there
 *   - a workflow composing `config/trusted-verifiers.<env>.json` for the container to read, which
 *     made the image a function of whose deployment it was
 *
 * Scope is code, tooling and workflows. `config/env-manifest.yaml` is NOT scanned by that pass and today
 * would fail it: 54 of its variables carry an `envs:` map naming this organisation's two environments,
 * which is the shape/values line being crossed in the other direction. Widening the NAME pass is the
 * second half of that fix, not a prerequisite for it.
 *
 * The manifest does get a second, narrower pass, for a third regression:
 *   - a manifest value naming a file in this tree that is not in this tree. `check:env` proves a
 *     declared variable is READ in code; nothing proved a declared PATH resolves, so a value can
 *     outlive its file and only a deployment finds out. Existence, not naming — this pass says
 *     nothing about whose data a value is.
 *
 *   node eng-tools/check-deployment-data.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { MANIFEST_PATH, loadManifest } from "./env-manifest.mjs";

const SCAN = ["eng-tools", "scripts", ".github/workflows", "services", "packages", "clients", "docker"];
/** A path segment naming somebody's environment. `local` and `_EXAMPLE` name nobody's. */
const ENVIRONMENTS = /^(dev|staging|prod|production|test)$/;
const SELF = "eng-tools/check-deployment-data.mjs";

const tracked = execFileSync("git", ["ls-files", "-z", ...SCAN], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => f !== SELF);

/** `config/…` up to whitespace or a quote. Template expressions are the point, so they are kept. */
const REFERENCE = /config\/[A-Za-z0-9_.${}()\-/]*/g;

const findings = [];
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable: nothing to match
  }
  text.split("\n").forEach((line, i) => {
    for (const hit of line.match(REFERENCE) ?? []) {
      // An expression resolves at run time and names no one environment.
      if (/[$][{(]|[$][A-Za-z_]/.test(hit)) continue;
      const named = hit
        .split("/")
        .slice(1)
        .flatMap((seg) => seg.replace(/\.json$/, "").split("."))
        .filter((seg) => ENVIRONMENTS.test(seg));
      if (named.length) findings.push({ file, line: i + 1, hit, named: named[0] });
    }
  });
}

// ── Pass 2: a path the manifest declares must be a path the image has ──────────────────────────
// `docker/service.Dockerfile` is `COPY . .`, so what the checkout has is what `/app/` has.
// Narrow on purpose: a URL, an absolute path, a glob or anything with a shell or template expression
// names something resolved elsewhere. Only a plain relative path claims this tree holds a file.
const isTreePath = (v) =>
  typeof v === "string" &&
  v.includes("/") &&
  !v.includes("://") &&
  !v.startsWith("/") &&
  !/[$*{}<>]/.test(v);

/** Every `default:` and `envs.<env>:` value in the manifest, with a label for the error message. */
function declaredPaths(node, trail = []) {
  const out = [];
  if (!node || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === "default" && isTreePath(value)) {
      out.push({ value, where: `${trail.at(-1) ?? "?"}: default` });
    } else if (key === "envs" && value && typeof value === "object") {
      for (const [env, envValue] of Object.entries(value)) {
        if (isTreePath(envValue)) out.push({ value: envValue, where: `${trail.at(-1) ?? "?"}: envs.${env}` });
      }
    } else {
      out.push(...declaredPaths(value, [...trail, key]));
    }
  }
  return out;
}

const missing = declaredPaths(loadManifest()).filter(({ value }) => !existsSync(value));

if (findings.length || missing.length) {
  for (const f of findings) {
    console.error(
      `::error file=${f.file},line=${f.line}::${f.hit} names the \`${f.named}\` deployment. ` +
        `This repository holds the contract's shape, not one deployment's values — take the path as an ` +
        `argument, or let the deployment's own configuration supply it.`,
    );
  }
  for (const m of missing) {
    console.error(
      `::error file=${MANIFEST_PATH}::${m.where} is \`${m.value}\`, which is not in this tree — so it ` +
        `is not in the image either (\`COPY . .\`), and anything reading it fails on a missing file. ` +
        `Either ship the file, or stop naming one: a document that belongs to a deployment reaches the ` +
        `container from that deployment, not from here.`,
    );
  }
  if (findings.length) console.error(`\n✗ ${findings.length} literal reference(s) to a deployment's data`);
  if (missing.length) console.error(`✗ ${missing.length} manifest value(s) naming a file the image does not have`);
  process.exit(1);
}

console.log(`✓ ${tracked.length} code, tooling and workflow file(s) name no deployment's data`);
console.log(`✓ every path ${MANIFEST_PATH} declares is in this tree, hence in the image`);
