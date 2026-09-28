#!/usr/bin/env node
/** Static: reads `packages/core` and talks to nothing. No build, no network. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const root = process.cwd();
const core = join(root, "packages/core");
const src = join(core, "src");

if (!existsSync(src)) {
  console.error(`no ${relative(root, src)} — run this from the repository root`);
  process.exit(2);
}

const INTERNAL = {
  "validators/result-url-list": "registry.ts's `@IsResultUrlList`",
  "validators/source-code-uri-list": "registry.ts's `@IsSourceCodeUriList`",
};

function modulesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return modulesUnder(full);
    return entry.isFile() && full.endsWith(".ts") && !full.endsWith("-test.ts") ? [full] : [];
  });
}

const nameOf = (file) => relative(src, file).replace(/\.ts$/, "");
const modules = modulesUnder(src).map(nameOf).filter((name) => name !== "index");
const known = new Set(modules);

const barrel = [...readFileSync(join(src, "index.ts"), "utf8").matchAll(/export \* from "\.\/(.+?)\.js"/g)].map(
  (match) => match[1],
);
const exportsMap = JSON.parse(readFileSync(join(core, "package.json"), "utf8")).exports;
const subpaths = Object.entries(exportsMap)
  .filter(([key]) => key !== ".")
  .map(([key, target]) => ({
    key,
    module: String(target.default ?? target).replace(/^\.\/dist\/src\//, "").replace(/\.js$/, ""),
  }));

const importedInternally = new Set();
for (const name of modules) {
  const file = join(src, `${name}.ts`);
  for (const match of readFileSync(file, "utf8").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = relative(src, resolve(dirname(file), match[1])).replace(/\.js$/, "");
    if (target !== name) importedInternally.add(target);
  }
}

const violations = [];
const reachable = new Set([...barrel, ...subpaths.map((s) => s.module), ...Object.keys(INTERNAL)]);

for (const name of modules) {
  if (!reachable.has(name)) {
    violations.push(
      `${name}.ts is reachable from nowhere — re-export it from src/index.ts, publish it in package.json ` +
        `"exports", or declare it in INTERNAL with what uses it`,
    );
  }
}
for (const name of barrel) {
  if (!known.has(name)) violations.push(`src/index.ts re-exports ./${name}.js, which does not exist`);
}
for (const { key, module } of subpaths) {
  if (!known.has(module)) violations.push(`package.json exports "${key}" -> ${module}, which does not exist`);
}
for (const [name, usedBy] of Object.entries(INTERNAL)) {
  if (!known.has(name)) {
    violations.push(`INTERNAL names ${name}, which does not exist — remove the entry`);
  } else if (!importedInternally.has(name)) {
    violations.push(`INTERNAL says ${name} is used by ${usedBy}, but no core module imports it — it is dead`);
  }
  if (barrel.includes(name) || subpaths.some((s) => s.module === name)) {
    violations.push(`${name} is declared INTERNAL but is also exported — it cannot be both`);
  }
}

if (violations.length > 0) {
  console.error("✗ @scvs/core has a module no consumer can reach, or an export that points at nothing:\n");
  for (const line of violations.sort()) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `✓ ${modules.length} @scvs/core modules, every one reachable: ${barrel.length} through the barrel, ` +
    `${subpaths.length} as subpaths, ${Object.keys(INTERNAL).length} internal`,
);
