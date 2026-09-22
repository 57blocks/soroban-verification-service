#!/usr/bin/env node
/** Static: reads `services/orchestrator-svc/src/modules` and talks to nothing. No AWS, no database, no build. */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const modulesDir = join(root, "services/orchestrator-svc/src/modules");

if (!existsSync(modulesDir)) {
  console.error(`no ${relative(root, modulesDir)} — run this from the repository root`);
  process.exit(2);
}

/**
 * A module's directory is its own business. Another module reaches it through `index.js` and nothing else, so
 * a file inside can be renamed, split or moved without a search across the service.
 *
 * One exception, and it is Nest's rather than ours: a `*.module.ts` names the modules it imports, which is how
 * a Nest module declares its graph. Routing that through a barrel buys nothing and risks a circular module
 * reference at boot.
 */
const CROSS_MODULE_IMPORT = /from\s+["']\.\.\/([a-z][a-z0-9-]*)\/([^"']+)["']/g;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

const moduleNames = readdirSync(modulesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const violations = [];
const surfaces = new Set();

for (const name of moduleNames) {
  for (const file of sourceFiles(join(modulesDir, name))) {
    const isModuleFile = file.endsWith(".module.ts");
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CROSS_MODULE_IMPORT)) {
      const [, target, rest] = match;
      if (target === name || !moduleNames.includes(target)) continue;
      surfaces.add(target);
      if (rest === "index.js") continue;
      if (isModuleFile && rest.endsWith(".module.js")) continue;
      violations.push(
        `${relative(root, file)} imports ../${target}/${rest} — reach it through ../${target}/index.js`,
      );
    }
  }
}

// A module others import from must actually have the surface they are told to use.
for (const target of [...surfaces].sort()) {
  const index = join(modulesDir, target, "index.ts");
  if (!existsSync(index) || !statSync(index).isFile()) {
    violations.push(`modules/${target} is imported across a boundary but has no index.ts`);
  }
}

if (violations.length > 0) {
  console.error("✗ a module reached past another module's surface:\n");
  for (const line of violations.sort()) console.error(`  ${line}`);
  console.error(
    "\nThe surface is the module's index.ts. Export what the other module needs from there, or — better — ask " +
      "whether the thing being reached for belongs in the module doing the reaching.",
  );
  process.exit(1);
}

console.log(
  `✓ ${moduleNames.length} orchestrator modules; every cross-module import goes through a surface ` +
    `(${surfaces.size} of them are imported from outside)`,
);
