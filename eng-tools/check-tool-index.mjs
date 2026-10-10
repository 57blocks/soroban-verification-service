#!/usr/bin/env node
/** Static: reads `eng-tools/`, every `package.json`, and `.github/workflows/`. No AWS, no network. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const TOOLS = "eng-tools";
const INDEX = join(TOOLS, "README.md");

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);

const toolFiles = readdirSync(join(ROOT, TOOLS))
  .filter((f) => f !== "README.md" && statSync(join(ROOT, TOOLS, f)).isFile())
  .sort();

const manifests = tracked.filter((f) => f.endsWith("package.json"));
const scriptsByTool = new Map();
const rootScripts = JSON.parse(read("package.json")).scripts ?? {};
for (const manifest of manifests) {
  const pkg = JSON.parse(read(manifest));
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    const hit = command.match(/eng-tools\/([A-Za-z0-9._-]+)/);
    if (!hit) continue;
    const entry = { name, manifest, isRoot: manifest === "package.json" };
    scriptsByTool.set(hit[1], [...(scriptsByTool.get(hit[1]) ?? []), entry]);
  }
}

const workflows = tracked.filter((f) => f.startsWith(".github/workflows/"));
const workflowText = workflows.map(read).join("\n");
const callableText = tracked
  .filter((f) => /\.(yml|yaml|sh|mjs|cjs|ts|tsx)$/.test(f) && !f.startsWith(`${TOOLS}/`))
  .map(read)
  .join("\n");
const documentText = tracked
  .filter((f) => f.endsWith(".md"))
  .map(read)
  .join("\n");
const toolText = new Map(toolFiles.map((f) => [f, read(join(TOOLS, f))]));

const findings = [];
const fail = (what) => findings.push(what);

const indexed = new Set(
  [...read(INDEX).matchAll(/^\|\s*\[`([A-Za-z0-9._-]+)`\]/gm)].map((m) => m[1])
);
for (const file of toolFiles) {
  if (!indexed.has(file)) fail(`${TOOLS}/${file} has no row in ${INDEX}`);
}
for (const row of indexed) {
  if (!toolFiles.includes(row)) fail(`${INDEX} has a row for ${row}, which does not exist`);
}

for (const [file, entries] of scriptsByTool) {
  if (toolFiles.includes(file)) continue;
  for (const e of entries) fail(`${e.manifest}'s "${e.name}" runs ${TOOLS}/${file}, which does not exist`);
}

for (const file of toolFiles) {
  const isCommand = toolText.get(file).startsWith("#!");
  const importedBy = toolFiles.filter(
    (other) => other !== file && toolText.get(other).includes(`./${file}`)
  );
  if (isCommand) {
    if (!scriptsByTool.has(file)) {
      fail(
        `${TOOLS}/${file} is a command (it has a shebang) and no package.json script names it — ` +
          `give it one, or remove it`
      );
    }
    continue;
  }
  if (importedBy.length === 0) {
    fail(`${TOOLS}/${file} has no shebang and nothing imports it — it is neither a command nor a library`);
  }
  if (scriptsByTool.has(file)) {
    fail(`${TOOLS}/${file} is bound to a script but has no shebang — add one, or drop the script`);
  }
}

const checkScripts = Object.keys(rootScripts).filter((n) => n.startsWith("check:"));
for (const name of checkScripts) {
  const tool = rootScripts[name].match(/eng-tools\/([A-Za-z0-9._-]+)/)?.[1];
  const named =
    new RegExp(`run ${name.replace(":", "[:]")}(?![A-Za-z0-9:_-])`).test(workflowText) ||
    (tool && workflowText.includes(`${TOOLS}/${tool}`));
  if (!named) {
    fail(
      `"${name}" is a gate by its prefix and no workflow runs it — wire it into a workflow, or ` +
        `rename it to the prefix that says who does (probe:, ops:, deploy:, release:, e2e:, export:)`
    );
  }
}

const AWS = [
  { re: /from\s+"@aws-sdk\//, what: 'imports an @aws-sdk client' },
  { re: /require\("@aws-sdk\//, what: 'requires an @aws-sdk client' },
  { re: /execFile(?:Sync)?\(\s*"aws"/, what: "spawns the aws CLI" },
];
for (const name of checkScripts) {
  const tool = rootScripts[name].match(/eng-tools\/([A-Za-z0-9._-]+)/)?.[1];
  if (!tool || !toolText.has(tool)) continue;
  for (const { re, what } of AWS) {
    if (re.test(toolText.get(tool))) {
      fail(`"${name}" ${what} — a check: runs with no credentials by contract; this is a probe:`);
    }
  }
}

const allScriptNames = new Set();
for (const manifest of manifests) {
  for (const name of Object.keys(JSON.parse(read(manifest)).scripts ?? {})) allScriptNames.add(name);
}
const RUN = /^[^\n]*?(?:pnpm(?:[^\S\n]+\S+)*|npm)[^\S\n]+run[^\S\n]+([a-z][a-z0-9:_-]*)(?!\*)/gm;
for (const [, name] of callableText.matchAll(RUN)) {
  if (!allScriptNames.has(name)) fail(`something runs "${name}", which no package.json defines`);
}
for (const [, name] of documentText.matchAll(RUN)) {
  if (!name.includes(":") || allScriptNames.has(name)) continue;
  fail(`a document tells the reader to run "${name}", which no package.json defines`);
}

if (findings.length > 0) {
  console.error(`✗ ${findings.length} finding(s)\n`);
  for (const f of [...new Set(findings)]) console.error(`  ${f}`);
  console.error(`\nThe contract is ${INDEX}'s header: a prefix names who runs a command and what red means.`);
  process.exit(1);
}
console.log(
  `✓ ${toolFiles.length} tool(s) indexed, ${checkScripts.length} check: script(s) each run by a workflow ` +
    `and none of them touching AWS`
);
