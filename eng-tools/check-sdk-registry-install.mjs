#!/usr/bin/env node
/** Installs the SDK from a registry into a scratch project outside the workspace and asserts what a consumer sees. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { binaryIn, typecheckInstalledDeclarations } from "./sdk-declaration-typecheck.mjs";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const OPEN_LICENCES = new Set(["Apache-2.0", "MIT"]);

const inGha = Boolean(process.env.GITHUB_ACTIONS);
const repoRoot = resolve(import.meta.dirname, "..");
const packageDir = resolve(process.argv[2] ?? join(repoRoot, "clients/sdk"));
const findings = [];

const secrets = [];

function redact(text) {
  return secrets.reduce((carry, secret) => carry.split(secret).join("***"), String(text));
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function describeRegistry(url) {
  try {
    const { host, pathname } = new URL(url);
    const labels = host.split(".");
    return `${labels.length >= 5 ? labels.slice(1).join(".") : host}${pathname}`;
  } catch {
    return "an unparseable registry URL";
  }
}

/** Run from outside the workspace, so the repository's own `.npmrc` cannot answer for a consumer's. */
function registryFor(scope, cwd) {
  for (const key of scope ? [`${scope}:registry`, "registry"] : ["registry"]) {
    const value = run("npm", ["config", "get", key], cwd).trim();
    if (value && value !== "undefined" && value !== "null") return value;
  }
  return "";
}

function configureRegistry(consumer, scope) {
  const scopedKey = scope ? `${scope}:registry` : "registry";
  const explicit = process.env.SCVS_SDK_REGISTRY?.trim();
  if (explicit) {
    writeFileSync(join(consumer, ".npmrc"), `${scopedKey}=${explicit}\n`, { mode: 0o600 });
    return explicit;
  }
  return registryFor(scope, consumer);
}

function diagnose(error) {
  const output = redact(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  if (/E404|404 Not Found/.test(output)) return "the registry has no such version (E404)";
  if (/E401|E403|401 Unauthorized|403 Forbidden/.test(output)) {
    return "the registry refused the request (E401/E403) — a public package should need no credential, so this is a failure and never a skip";
  }
  return output.trim().split("\n").slice(-5).join(" / ") || redact(error.message);
}

const manifest = readJson(join(packageDir, "package.json"));
const name = manifest.name;
const version = process.env.SCVS_SDK_VERSION?.trim() || manifest.version;
const scope = name.startsWith("@") ? name.split("/")[0] : "";

let scratch;
let installedManifest;
let addedPackages;
let registry = "";

try {
  // Outside the workspace: inside it, pnpm links answer for `@scvs/*` and no registry is consulted.
  scratch = mkdtempSync(join(tmpdir(), "scvs-registry-install-"));
  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "scvs-registry-install-consumer", version: "0.0.0", type: "module", private: true }),
  );

  try {
    registry = configureRegistry(consumer, scope);
  } catch (error) {
    findings.push(
      `could not reach the registry: ${diagnose(error)}`,
    );
  }

  let installOutput;
  try {
    installOutput = run(
      "npm",
      ["install", `${name}@${version}`, "--no-audit", "--no-fund", "--ignore-scripts", "--json"],
      consumer,
    );
  } catch (error) {
    findings.push(`${name}@${version} does not install from ${describeRegistry(registry)}: ${diagnose(error)}`);
  }

  if (installOutput !== undefined) {
    try {
      addedPackages = JSON.parse(installOutput).added;
    } catch {
      addedPackages = Number(/added (\d+)/.exec(installOutput)?.[1]) || "an unreported number of";
    }
  }

  const installedDir = join(consumer, "node_modules", ...name.split("/"));

  if (!findings.length && !existsSync(installedDir)) {
    findings.push(`npm reported success but ${name} is not in the consumer's node_modules`);
  }

  if (!findings.length) {
    const lock = readJson(join(consumer, "package-lock.json"));
    const resolved = lock.packages?.[`node_modules/${name}`]?.resolved ?? "";
    if (!/^https?:\/\//.test(resolved)) {
      findings.push(
        `${name} did not come from a registry: the lockfile resolves it as \`${resolved || "nothing"}\`, ` +
          `so a local path, tarball or workspace link answered instead`,
      );
    }

    installedManifest = readJson(join(installedDir, "package.json"));

    if (installedManifest.version !== version) {
      findings.push(
        `the registry served ${name}@${installedManifest.version}, not the ${version} this release published`,
      );
    } else if (!SEMVER.test(installedManifest.version)) {
      findings.push(`${installedManifest.version} is not a semantic version`);
    }

    if (!OPEN_LICENCES.has(installedManifest.license)) {
      findings.push(
        `the installed manifest declares \`${installedManifest.license ?? "no licence"}\` — the SDK must ` +
          `carry an open licence, and rule 26 of docs/invariants.md makes it Apache-2.0`,
      );
    }

    const declarations = installedManifest.exports?.["."]?.types ?? installedManifest.types;
    if (!declarations) {
      findings.push("the installed manifest names no type declarations, so a TypeScript consumer has none");
    } else if (!existsSync(join(installedDir, declarations))) {
      findings.push(`the installed manifest names \`${declarations}\`, which the published files do not contain`);
    }
  }

  if (!findings.length) {
    writeFileSync(
      join(consumer, "run.mjs"),
      `import "reflect-metadata";
import assert from "node:assert/strict";
import { computeAgreement, displayStatusOf, newClient, validateStatusObject } from "${name}";

const tvl = {
  schema: "stellar-trusted-verifiers-list-v1",
  verifiers: [
    {
      id: "scvs-dev",
      display_name: "SCVS Dev Verifier",
      cdn_root: "https://results.dev.sv.example.com",
      manifest_url: "https://results.dev.sv.example.com/verifier-manifest.json",
      bulk_load_url: "https://dev.sv.example.com/api/verification/v1/wasms.json",
      status: "active",
    },
  ],
  updated_at: "2026-08-20T00:00:00.000Z",
};

const client = newClient({ tvl });
assert.equal(client.verifiers.length, 1);
assert.equal(client.verifiers[0].id, "scvs-dev");
assert.throws(() => newClient({ tvl: { ...tvl, verifiers: [{ id: "" }] } }));

const statusObject = {
  schema_version: "1.0",
  wasm_hash: "cb2fc3a1b4d5e6f7081928374655647382910abcdef0123456789abcdef01234",
  updated_at: "2026-06-04T13:00:00Z",
  source_code_verifications: [
    {
      verifier: { name: "Verifier A", url: "https://a.example.com" },
      status: "verified",
      source_repo: "https://github.com/user/my-contract",
      source_rev: "abc1234567890abcdef1234567890abcdef12345",
      processed_at: "2026-06-04T12:00:00Z",
    },
    {
      verifier: { name: "Verifier B", url: "https://b.example.com" },
      status: "mismatched",
      source_repo: "https://github.com/user/my-contract",
      source_rev: "abc1234567890abcdef1234567890abcdef12345",
      rebuilt_hash: "999888777666555444333222111000fedcba9876543210fedcba9876543210fe",
      processed_at: "2026-06-04T13:00:00Z",
    },
  ],
};

const parsed = validateStatusObject(statusObject, "E2E-SDK-06");
assert.equal(parsed.source_code_verifications.length, 2);
assert.deepEqual(parsed.source_code_verifications.map(displayStatusOf), ["verified", "mismatched"]);
assert.equal(computeAgreement(parsed.source_code_verifications), "disputed");
`,
    );
    try {
      run("node", ["run.mjs"], consumer);
    } catch (error) {
      findings.push(`the installed package does not aggregate: ${diagnose(error)}`);
    }
  }

  if (!findings.length) {
    const finding = typecheckInstalledDeclarations({
      consumerDir: consumer,
      packageName: name,
      tsc: binary("tsc"),
      diagnose,
      run,
    });
    if (finding) findings.push(finding);
  }

  if (!findings.length) {
    const esbuild = binary("esbuild");
    if (!esbuild) {
      findings.push("no `esbuild` binary in this checkout, so the installed package was never bundled for a browser");
    } else {
      const bundle = join(scratch, "browser.mjs");
      writeFileSync(
        join(consumer, "browser-entry.mjs"),
        [
          `import { computeAgreement, newClient, validateStatusObject } from "${name}";`,
          `globalThis.__scvs = { computeAgreement, newClient, validateStatusObject };`,
        ].join("\n"),
      );
      try {
        run(
          esbuild,
          ["browser-entry.mjs", "--bundle", "--platform=browser", "--format=esm", "--target=es2022", `--outfile=${bundle}`, "--log-level=error"],
          consumer,
        );
        const builtins = [...new Set(readFileSync(bundle, "utf8").match(/["']node:[a-z/]+["']/g) ?? [])];
        if (builtins.length) {
          findings.push(
            `the installed package's browser bundle still imports ${builtins.join(", ")} — the SDK promises ` +
              `to run in a browser without polyfills a consumer supplies`,
          );
        }
      } catch (error) {
        findings.push(`the installed package does not bundle for a browser: ${diagnose(error)}`);
      }
    }
  }
} catch (error) {
  findings.push(`the gate could not run to completion: ${diagnose(error)}`);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

function binary(tool) {
  return binaryIn([packageDir, repoRoot], tool);
}

for (const finding of findings) console.log(inGha ? `::error::${redact(finding)}` : `  ✗ ${redact(finding)}`);

if (!findings.length) {
  console.log(`── registry: ${describeRegistry(registry)}`);
  console.log(`── installed ${name}@${installedManifest.version} · ${installedManifest.license} · ${addedPackages} packages`);
}

console.log(
  findings.length
    ? `\n${findings.length} finding(s) — E2E-SDK-06 does not pass against this registry.`
    : `✓ ${name}@${installedManifest.version} installs from the registry outside the workspace, aggregates, typechecks and bundles for a browser`,
);
process.exit(findings.length ? 1 : 0);
