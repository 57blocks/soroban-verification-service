/** Shared by `report:advisories` and `check:advisories`: every `pnpm audit` advisory, split by whether it reaches a shipped unit. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];

export function collectAdvisories() {
  const ROOT = process.cwd();

  const SHIPPED = ["services/*", "clients/web", "clients/docs", "clients/sdk"];

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
    if (!out.startsWith("{")) return { unavailable: `\`pnpm audit\` produced no JSON: ${error.message}` };
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

  rows.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.module.localeCompare(b.module));
  const reaching = rows.filter((r) => r.production.length > 0);
  const tooling = rows.filter((r) => r.production.length === 0);

  return { rows, reaching, tooling, counts: audit.metadata?.vulnerabilities ?? {} };
}
