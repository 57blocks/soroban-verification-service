#!/usr/bin/env node
/** Static: refuses a literal reference to one deployment's data, and a manifest path missing from the tree. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { MANIFEST_PATH, loadManifest } from "./env-manifest.mjs";

const SCAN = ["eng-tools", "scripts", ".github/workflows", "services", "packages", "clients", "docker"];
const ENVIRONMENTS = /^(dev|staging|prod|production|test)$/;
const SELF = "eng-tools/check-deployment-data.mjs";

const tracked = execFileSync("git", ["ls-files", "-z", ...SCAN], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((f) => f !== SELF);

const REFERENCE = /config\/[A-Za-z0-9_.${}()\-/]*/g;

const findings = [];
for (const file of tracked) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const hit of line.match(REFERENCE) ?? []) {
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

const isTreePath = (v) =>
  typeof v === "string" &&
  v.includes("/") &&
  !v.includes("://") &&
  !v.startsWith("/") &&
  !/[$*{}<>]/.test(v);

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
