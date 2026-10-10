#!/usr/bin/env node
/** Read-only; reads source, needs no build and no database. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const inGha = Boolean(process.env.GITHUB_ACTIONS);

const SERVICE_TEST_DIRS = ["services/verification-svc/test", "services/orchestrator-svc/test", "services/query-svc/test"];

const REAL_CONNECTION_PATTERN =
  /\bcreatePrismaClient\s*\(|\bnew PrismaClient\s*\(|\bmoduleRef\.get\s*\(\s*PRISMA_CLIENT\s*\)/;
const CREATED_ROWS_IMPORT_PATTERN = /from\s+["']@scvs\/db\/testing["']/;
const LIFECYCLE_HOOK_PATTERN = /\b(afterAll|afterEach)\s*\(/;
const SCOPED_DELETE_MANY_PATTERN = /\.deleteMany\s*\(\s*\{[^}]*\bin\s*:/s;

function specFilesIn(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => join(dir, f));
}

const findings = [];
const notes = [];
let checked = 0;

for (const dir of SERVICE_TEST_DIRS) {
  for (const path of specFilesIn(dir)) {
    checked += 1;
    const src = readFileSync(path, "utf8");
    const opensRealConnection = REAL_CONNECTION_PATTERN.test(src);
    const importsCreatedRows = CREATED_ROWS_IMPORT_PATTERN.test(src);
    const hasScopedHandRolledCleanup =
      LIFECYCLE_HOOK_PATTERN.test(src) && SCOPED_DELETE_MANY_PATTERN.test(src);
    const hasCleanup = importsCreatedRows || hasScopedHandRolledCleanup;

    if (opensRealConnection && !hasCleanup) {
      findings.push(
        `${path} opens a real Prisma connection (createPrismaClient/new PrismaClient) but has neither ` +
          `a CreatedRows import (@scvs/db/testing) nor an afterAll/afterEach with an id-scoped ` +
          `deleteMany (\`in:\`) — see rule 21 of docs/invariants.md`,
      );
    } else if (!opensRealConnection && importsCreatedRows) {
      notes.push(`${path} imports CreatedRows but this script found no real Prisma connection in it`);
    }
  }
}

for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);
for (const n of notes) console.log(inGha ? `::warning::${n}` : `  ! ${n}`);

console.log(
  findings.length
    ? `\n${findings.length} spec(s) write real rows with no CreatedRows cleanup, across ${checked} spec files checked.`
    : `✓ all ${checked} spec files that open a real Prisma connection import CreatedRows`,
);
process.exit(findings.length ? 1 : 0);
