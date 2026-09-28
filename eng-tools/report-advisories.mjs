#!/usr/bin/env node
/** Static plus the npm advisory database, no AWS. Exits 0 unconditionally — it reports, it never gates. */
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

const SHIPPED = ["services/*", "clients/web", "clients/sdk"];

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const manifests = execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => f !== "package.json");

/** `pnpm audit` roots each path at the workspace directory, `/` written as `__`. */
const byDir = new Map(manifests.map((m) => [m.replace(/\/package\.json$/, ""), JSON.parse(read(m))]));
const byName = new Map([...byDir].map(([dir, pkg]) => [pkg.name, dir]));

const matches = (dir) => SHIPPED.some((p) => (p.endsWith("/*") ? dir.startsWith(p.slice(0, -1)) : dir === p));

const shipped = new Set([...byDir.keys()].filter(matches));
for (let grew = true; grew; ) {
  grew = false;
  for (const dir of [...shipped]) {
    for (const name of Object.keys(byDir.get(dir).dependencies ?? {})) {
      const dep = byName.get(name);
      if (dep && !shipped.has(dep)) (shipped.add(dep), (grew = true));
    }
  }
}

let audit;
try {
  audit = JSON.parse(execFileSync("pnpm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 }));
} catch (error) {
  // `pnpm audit` exits non-zero whenever it found anything, so stdout is the result, not the failure.
  const out = error.stdout?.toString() ?? "";
  if (!out.startsWith("{")) {
    console.log(`advisory report unavailable — \`pnpm audit\` produced no JSON: ${error.message}`);
    process.exit(0);
  }
  audit = JSON.parse(out);
}

function classify(path) {
  const [root, first] = path.split(">");
  const dir = root.replace(/__/g, "/");
  if (!shipped.has(dir) || !byDir.has(dir)) return undefined;
  return first in (byDir.get(dir).dependencies ?? {}) ? dir : undefined;
}

const rows = Object.values(audit.advisories ?? {}).map((advisory) => {
  const paths = [...new Set(advisory.findings.flatMap((f) => f.paths))];
  return {
    severity: advisory.severity,
    module: advisory.module_name,
    installed: [...new Set(advisory.findings.map((f) => f.version))].join(", "),
    patched: advisory.patched_versions,
    id: advisory.github_advisory_id ?? advisory.cves?.[0] ?? String(advisory.id),
    url: advisory.url,
    path: paths[0],
    production: [...new Set(paths.map(classify).filter(Boolean))],
  };
});

const ORDER = ["critical", "high", "moderate", "low", "info"];
rows.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.module.localeCompare(b.module));
const reaching = rows.filter((r) => r.production.length > 0);
const tooling = rows.filter((r) => r.production.length === 0);

const counts = audit.metadata?.vulnerabilities ?? {};
const headline =
  `${rows.length} advisor${rows.length === 1 ? "y" : "ies"} — ` +
  ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ") +
  `; ${reaching.length} reach${reaching.length === 1 ? "es" : ""} a shipped dependency edge`;

const table = (title, list, note) =>
  list.length === 0
    ? [`### ${title}\n`, "None.\n"]
    : [
        `### ${title}\n`,
        ...(note ? [`${note}\n`] : []),
        "| severity | package | installed | patched | path | advisory |",
        "| :-- | :-- | :-- | :-- | :-- | :-- |",
        ...list.map(
          (r) => `| ${r.severity} | \`${r.module}\` | ${r.installed} | ${r.patched} | \`${r.path}\` | [${r.id}](${r.url}) |`,
        ),
        "",
      ];

const lines = [
  `## Dependency advisories\n`,
  `${headline}.\n`,
  ...table(
    "Reaches a shipped unit",
    reaching,
    "Left the workspace through a `dependencies` edge of an image, the console bundle, or the SDK tarball.",
  ),
  ...table("Build, test, and codegen only", tooling),
  "_Reporting only — this step never fails the run._",
];

console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
