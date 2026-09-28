#!/usr/bin/env node
/** A deny-list for deployment identifiers plus gitleaks, over the snapshot the public export carries. Needs Docker. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { countIdentifiers, rules, rulesPath } from "./internal-identifiers.mjs";

const inGha = Boolean(process.env.GITHUB_ACTIONS);
const findings = [];
const notes = [];

const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};
const scanRoot = argOf("--root");
const zeroBaseline = process.argv.includes("--zero-baseline") || Boolean(scanRoot);

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const root = scanRoot ? scanRoot : repoRoot;

const GITLEAKS = "ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854";

const BINARY = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|wasm|zip|tar|gz|xz|bin)$/i;
const SKIP = new Set([".git", "node_modules", "dist", ".turbo"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(relative(root, abs));
  }
  return out;
}

const trackedFiles = () =>
  execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
// Imported dynamically: the export drops `export-manifest.mjs`, and a static import would crash there.
async function publicationScope() {
  if (scanRoot) return walk(root);
  const tracked = trackedFiles();
  if (!existsSync(join(repoRoot, "export/manifest.json"))) return tracked;
  const { readManifest, shipping } = await import("./export-manifest.mjs");
  return shipping(readManifest(repoRoot), tracked);
}
const inScope = (await publicationScope()).filter((f) => !BINARY.test(f));

const observed = {};
for (const file of inScope) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  const counts = countIdentifiers(text);
  if (Object.keys(counts).length > 0) observed[file] = counts;
}

const pending = zeroBaseline ? {} : rules.pending ?? {};
for (const [file, counts] of Object.entries(observed)) {
  for (const [rule, count] of Object.entries(counts)) {
    const allowed = pending[file]?.[rule] ?? 0;
    if (count <= allowed) continue;
    findings.push(
      allowed === 0
        ? `${file} — ${count} ${rule} occurrence(s), and nothing authorises any here. This identifier ` +
          `must not reach the public repository; use a placeholder, or resolve it at deploy time`
        : `${file} — ${count} ${rule} occurrence(s), baseline allows ${allowed}. The baseline only shrinks`,
    );
  }
}

for (const [file, counts] of Object.entries(pending)) {
  for (const [rule, allowed] of Object.entries(counts)) {
    const count = observed[file]?.[rule] ?? 0;
    if (count < allowed) {
      findings.push(
        `eng-tools/internal-identifiers.json allows ${allowed} ${rule} in ${file} and only ${count} ` +
          `remain — lower it to ${count} (or drop the entry) so the ratchet holds`,
      );
    }
  }
}

const remaining = Object.values(pending).reduce(
  (n, counts) => n + Object.values(counts).reduce((m, c) => m + c, 0),
  0,
);
notes.push(
  zeroBaseline
    ? `${inScope.length} file(s) scanned under ${root}; no occurrence of any rule is authorised`
    : `${inScope.length} in-scope file(s) scanned; ${remaining} identifier occurrence(s) still allowed by ` +
      `the baseline, across ${Object.keys(pending).length} file(s)`,
);

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
if (!hasDocker) {
  const why = "gitleaks needs a Docker daemon and none answered";
  if (inGha || zeroBaseline) findings.push(`${why} — a gate may not skip itself`);
  else notes.push(`${why}; the deny-list above still ran`);
} else {
  const snapshot = mkdtempSync(join(tmpdir(), "scvs-secret-scan-"));
  try {
    for (const file of inScope) {
      mkdirSync(join(snapshot, dirname(file)), { recursive: true });
      cpSync(join(root, file), join(snapshot, file));
    }
    cpSync(join(repoRoot, ".gitleaks.toml"), join(snapshot, ".gitleaks.toml"));

    const report = join(snapshot, "gitleaks-report.json");
    const run = spawnSync(
      "docker",
      [
        "run", "--rm", "--network", "none",
        "-v", `${snapshot}:/snapshot`,
        GITLEAKS,
        "detect", "--source=/snapshot", "--no-git", "--redact",
        "--config=/snapshot/.gitleaks.toml",
        "--report-format=json", "--report-path=/snapshot/gitleaks-report.json",
        "--exit-code=0",
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) {
      findings.push(`gitleaks did not run: ${(run.stderr || run.error?.message || "").trim()}`);
    } else {
      const leaks = JSON.parse(readFileSync(report, "utf8") || "[]");
      for (const leak of leaks) {
        const file = leak.File.replace(/^\/?snapshot\//, "");
        findings.push(
          `${file}:${leak.StartLine} — gitleaks rule "${leak.RuleID}". If it is a fixture rather than ` +
            `a credential, allowlist it in .gitleaks.toml with a reason; otherwise rotate it first`,
        );
      }
      notes.push(`gitleaks ${GITLEAKS.split("@")[0].split(":").pop()} scanned the same ${inScope.length} file(s)`);
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);
for (const n of notes) console.log(inGha ? `::notice::${n}` : `  ! ${n}`);

// Shrink-only: the flag may lower the baseline, never raise it.
if (process.argv.includes("--write-baseline")) {
  if (scanRoot) {
    console.error("--write-baseline writes this repository's baseline; it is meaningless over --root");
    process.exit(2);
  }
  const shrunk = {};
  for (const [file, counts] of Object.entries(rules.pending ?? {})) {
    for (const [rule, allowed] of Object.entries(counts)) {
      const count = Math.min(observed[file]?.[rule] ?? 0, allowed);
      if (count > 0) (shrunk[file] ??= {})[rule] = count;
    }
  }
  writeFileSync(
    rulesPath,
    `${JSON.stringify({ ...rules, pending: Object.fromEntries(Object.entries(shrunk).sort()) }, null, 2)}\n`,
  );
  console.log("\nBaseline lowered to what is on disk. It cannot be raised here — read the diff.");
  process.exit(0);
}

console.log(
  findings.length
    ? `\n${findings.length} finding(s). Nothing here is fixed by widening the gate.`
    : `\n✓ ${zeroBaseline ? "the export product" : "the publication snapshot"} carries no unauthorised ` +
      `identifier and no gitleaks finding`,
);
process.exit(findings.length ? 1 : 0);
