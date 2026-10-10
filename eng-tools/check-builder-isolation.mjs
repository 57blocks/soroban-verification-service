#!/usr/bin/env node
/** Static: reads `services/builder/src` and talks to nothing. No AWS, no credentials, no network. */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

const root = process.cwd();
const srcDir = join(root, "services/builder/src");

if (!existsSync(srcDir)) {
  console.error(`no ${relative(root, srcDir)} — run this from the repository root`);
  process.exit(2);
}

const CAPABILITY_PATTERNS = [
  { re: /"docker"\s*,/, what: 'spawns `docker` (argv literal "docker")' },
  { re: /--docker-host/, what: "passes --docker-host, i.e. addresses a container runtime" },
  // `(?<!function )`: defining `stellarCli()` is not invoking it.
  {
    re: /(?<!function )\bstellarCli\s*\([^)]*\)/,
    what: "invokes the Stellar CLI, whose verify path starts a container",
  },
];

const ATTACKER_INPUT_PATTERNS = [
  { re: /"tar"\s*,/, what: 'spawns `tar` on submitted bytes (argv literal "tar")' },
  { re: /"git"\s*,/, what: 'spawns `git` on a submitted URL (argv literal "git")' },
  { re: /\bextractSourceArchive\b/, what: "extracts a submitted archive" },
  { re: /\bmaterializeSource\b/, what: "downloads/clones submitted source" },
];

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) files.push(full);
  }
})(srcDir);

const importsOf = (file) => {
  const source = readFileSync(file, "utf8")
    .replace(/^\s*import\s+type\s+[\s\S]*?from\s+"[^"]+";?\s*$/gm, "");
  const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
  return specifiers
    .map((spec) => {
      const asTs = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      return existsSync(asTs) ? asTs : undefined;
    })
    .filter(Boolean);
};

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const hits = (file, patterns) => {
  const source = withoutComments(readFileSync(file, "utf8"));
  return patterns.filter((p) => p.re.test(source)).map((p) => p.what);
};

const imported = new Set(files.flatMap(importsOf));
const entrypoints = files.filter((f) => !imported.has(f));

const findings = [];

for (const entry of entrypoints) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file));
  }

  const capability = [];
  const attacker = [];
  for (const file of seen) {
    const rel = relative(root, file);
    for (const what of hits(file, CAPABILITY_PATTERNS)) capability.push({ rel, what });
    for (const what of hits(file, ATTACKER_INPUT_PATTERNS)) attacker.push({ rel, what });
  }

  const label = relative(root, entry);
  console.log(`── entrypoint ${label} (${seen.size} files reachable)`);
  console.log(`   container-execution capability: ${capability.length} site(s)`);
  for (const c of capability) console.log(`     ${c.rel} — ${c.what}`);
  console.log(`   attacker-controlled input:      ${attacker.length} site(s)`);
  for (const a of attacker) console.log(`     ${a.rel} — ${a.what}`);
  console.log("");

  if (capability.length > 0 && attacker.length > 0) {
    const files_ = [...new Set(attacker.map((a) => a.rel))];
    findings.push(
      `${label} reaches BOTH: it can start containers (${capability.length} site(s)) and it parses ` +
        `submitted input (${attacker.length} site(s), in ${files_.length} file(s): ${files_.join(", ")}). ` +
        `source retrieval and extraction must happen in a step that does not hold the capability`,
    );
  }

  const bothInOneFile = [...new Set(capability.map((c) => c.rel))].filter((rel) =>
    attacker.some((a) => a.rel === rel),
  );
  for (const rel of bothInOneFile) {
    findings.push(
      `${rel} holds the capability AND parses submitted input in the same file — the tightest form ` +
        `of that violation`,
    );
  }
}

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);

console.log(
  findings.length
    ? `\n${findings.length} finding(s) across ${entrypoints.length} entrypoint(s): a step that can start ` +
        `containers must never also retrieve or extract submitted source.\n` +
        `Passing this check is necessary but NOT sufficient: it reasons about reachability, not about ` +
        `which container the code runs in.`
    : `✓ no builder entrypoint reaches both container-execution capability and attacker-controlled ` +
        `input (necessary, not sufficient: it reasons about reachability, not about which container runs it)`,
);
process.exit(findings.length ? 1 : 0);
