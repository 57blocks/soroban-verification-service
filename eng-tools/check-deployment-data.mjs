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
 * Scope is code, tooling and workflows. `config/env-manifest.yaml` is NOT scanned and today would fail:
 * 54 of its variables carry an `envs:` map naming this organisation's two environments, which is the
 * shape/values line being crossed in the other direction. Widening this gate is the second half of that
 * fix, not a prerequisite for it.
 *
 *   node eng-tools/check-deployment-data.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

if (findings.length) {
  for (const f of findings) {
    console.error(
      `::error file=${f.file},line=${f.line}::${f.hit} names the \`${f.named}\` deployment. ` +
        `This repository holds the contract's shape, not one deployment's values — take the path as an ` +
        `argument, or let the deployment's own configuration supply it.`,
    );
  }
  console.error(`\n✗ ${findings.length} literal reference(s) to a deployment's data`);
  process.exit(1);
}

console.log(`✓ ${tracked.length} code, tooling and workflow file(s) name no deployment's data`);
