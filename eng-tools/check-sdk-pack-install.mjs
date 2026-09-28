#!/usr/bin/env node
/** Packs `clients/sdk`, installs the tarball outside the workspace, and runs one aggregation through it. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { binaryIn, typecheckInstalledDeclarations } from "./sdk-declaration-typecheck.mjs";

const inGha = Boolean(process.env.GITHUB_ACTIONS);
const packageDir = resolve(process.argv[2] ?? process.cwd());
const repoRoot = resolve(import.meta.dirname, "..");
const findings = [];

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function manifestAt(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function workspacePackages() {
  const globs = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .map((line) => line.match(/^\s*-\s*"?([^"#]+?)"?\s*$/)?.[1])
    .filter(Boolean);

  const names = new Map();
  for (const glob of globs) {
    const parent = glob.endsWith("/*") ? glob.slice(0, -2) : null;
    const dirs = parent
      ? readdirSync(join(repoRoot, parent), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(repoRoot, parent, entry.name))
      : [join(repoRoot, glob)];
    for (const dir of dirs) {
      try {
        const { name, private: isPrivate } = manifestAt(dir);
        if (name) names.set(name, Boolean(isPrivate));
      } catch {
      }
    }
  }
  return names;
}

function lastLines(error) {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-5).join(" / ");
  return output || error.message;
}

const manifest = manifestAt(packageDir);

if (manifest.private) {
  findings.push(
    `${manifest.name} is \`private: true\` — \`npm publish\` throws EPRIVATE and \`pnpm publish\` ` +
      `exits 0 having published nothing. Neither is a state a release workflow can detect`,
  );
}

const internal = workspacePackages();
const unresolvable = Object.entries(manifest.dependencies ?? {})
  .filter(([name, range]) => internal.get(name) === true || /^(workspace|link|file):/.test(range))
  .map(([name]) => name);

if (unresolvable.length) {
  findings.push(
    `runtime dependencies no consumer can install: ${unresolvable.join(", ")} — each is a ` +
      `workspace package that is never published. tsup compiles them into dist, so they belong in ` +
      `devDependencies (see tsup.config.ts)`,
  );
}

let scratch;
if (!findings.length) {
  try {
    scratch = mkdtempSync(join(tmpdir(), "scvs-pack-install-"));

    // `npm pack`, not `pnpm pack`: releases publish with npm.
    run("npm", ["pack", "--pack-destination", scratch], packageDir);
    const tarball = readdirSync(scratch).find((entry) => entry.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack produced no tarball");

    // Outside the workspace: inside it, pnpm links resolve `@scvs/*` and the tarball's manifest goes untested.
    const consumer = join(scratch, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "scvs-pack-install-consumer", version: "0.0.0", type: "module", private: true }),
    );

    writeFileSync(
      join(consumer, "run.mjs"),
      [
        `import "reflect-metadata";`,
        `import assert from "node:assert/strict";`,
        `import { readFileSync } from "node:fs";`,
        `import { validateStatusObject, computeAgreement } from "${manifest.name}";`,
        `const fixture = ${JSON.stringify(join(repoRoot, "test/fixtures/registry/200-two-verifiers.json"))};`,
        `const parsed = validateStatusObject(JSON.parse(readFileSync(fixture, "utf8")), "fixture");`,
        `assert.equal(parsed.source_code_verifications.length, 2);`,
        `assert.equal(computeAgreement(parsed.source_code_verifications), "disputed");`,
      ].join("\n"),
    );

    run("npm", ["install", join(scratch, tarball), "--no-audit", "--no-fund", "--ignore-scripts"], consumer);
    run("node", ["run.mjs"], consumer);

    const finding = typecheckInstalledDeclarations({
      consumerDir: consumer,
      packageName: manifest.name,
      tsc: binaryIn([packageDir, repoRoot], "tsc"),
      diagnose: lastLines,
      run,
    });
    if (finding) findings.push(finding);
  } catch (error) {
    findings.push(`the packed tarball does not install and run outside the workspace: ${lastLines(error)}`);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

for (const finding of findings) console.log(inGha ? `::error::${finding}` : `  ✗ ${finding}`);

console.log(
  findings.length
    ? `\n${findings.length} packaging finding(s) — this package is not installable by a consumer.`
    : `✓ ${manifest.name}@${manifest.version} packs, installs outside the workspace, and aggregates`,
);
process.exit(findings.length ? 1 : 0);
