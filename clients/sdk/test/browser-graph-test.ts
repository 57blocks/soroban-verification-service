import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdkSrc = resolve(here, "../src");
const workspace = resolve(here, "../../..");

function resolveWorkspaceSpecifier(specifier: string): string | undefined {
  const match = /^@scvs\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!match) return undefined;
  const [, pkg, subpath] = match;
  const dir = pkg === "sdk" ? "clients/sdk" : `packages/${pkg}`;
  return resolve(workspace, dir, "dist/src", `${subpath ?? "index"}.js`);
}

// Three forms: `import "reflect-metadata"` names no binding, so a walker requiring `from` misses bare imports.
const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;])import\s*["']([^"']+)["']/gm;

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) found.push(specifier);
  }
  return found;
}

async function sdkEntryPoints(): Promise<string[]> {
  const files = await readdir(sdkSrc);
  const entries = new Set<string>();
  for (const file of files.filter((name) => name.endsWith(".ts"))) {
    const source = await readFile(resolve(sdkSrc, file), "utf8");
    for (const specifier of specifiersIn(source)) {
      const resolved = resolveWorkspaceSpecifier(specifier);
      if (resolved !== undefined) entries.add(resolved);
    }
  }
  assert.ok(entries.size > 0, "found no @scvs/* imports in clients/sdk/src — did the layout change?");
  return [...entries];
}

export async function assertBrowserSafeGraph(): Promise<string[]> {
  const visited = new Set<string>();
  const violations: string[] = [];
  const queue = await sdkEntryPoints();

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);

    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      violations.push(`unresolvable file in the graph: ${file} (was the workspace built?)`);
      continue;
    }

    for (const specifier of specifiersIn(source)) {
      if (specifier.startsWith("node:")) {
        violations.push(`${relative(file)} imports the Node builtin "${specifier}"`);
        continue;
      }
      if (specifier.startsWith("@nestjs/")) {
        violations.push(`${relative(file)} imports "${specifier}" — Nest must not reach a browser bundle`);
        continue;
      }
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      const workspaceFile = resolveWorkspaceSpecifier(specifier);
      if (workspaceFile !== undefined) {
        queue.push(workspaceFile);
        continue;
      }
    }
  }

  return violations;
}

function relative(file: string): string {
  return file.startsWith(workspace) ? file.slice(workspace.length + 1) : file;
}

async function main(): Promise<void> {
  const violations = await assertBrowserSafeGraph();
  assert.deepEqual(
    violations,
    [],
    `the SDK's module graph is not browser-safe:\n  - ${violations.join("\n  - ")}`,
  );
  console.log("SDK browser-graph check passed (no node: builtin and no @nestjs package is reachable)");
}

await main();
