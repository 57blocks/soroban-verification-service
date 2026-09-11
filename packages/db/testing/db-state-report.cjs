/**
 * The database-state banner behind every DB-touching service's Jest `globalSetup` (`db-state-setup.cjs`, which
 * exists only because Jest wants one default export per hook).
 */
const { Client } = require("pg");

// `abuse_control` is deliberately absent.
const TABLES = ["jobs", "rebuilds", "uploads", "trusted_verifiers"];
const CONNECT_TIMEOUT_MS = 3_000;

async function countRows() {
  // `@scvs/db`'s own resolution, not a second copy of it.
  require("./local-env.cjs");
  const { readDbEnv, toConnectionString } = await import("../dist/src/connection.js");
  const client = new Client({
    connectionString: toConnectionString(readDbEnv()),
    // Without this a black-holed host (VPN up, container paused) hangs `pnpm run test` before the first test,
    // with no output and no timeout to end it.
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const counts = {};
    for (const table of TABLES) {
      const { rows } = await client.query(`select count(*)::int as n from ${table}`);
      counts[table] = rows[0].n;
    }
    return counts;
  } finally {
    await client.end();
  }
}

function banner(lines) {
  const width = Math.max(...lines.map((line) => line.length)) + 2;
  const rule = "─".repeat(width);
  process.stderr.write(`\n${rule}\n${lines.map((line) => ` ${line}`).join("\n")}\n${rule}\n\n`);
}

function describeCounts(counts, format) {
  return TABLES.filter((table) => format(counts, table) !== undefined)
    .map((table) => format(counts, table))
    .join(" ");
}

async function reportStateBeforeRun() {
  try {
    const counts = await countRows();
    const dirty = describeCounts(counts, (c, t) => (c[t] > 0 ? `${t}=${c[t]}` : undefined));
    if (!dirty) return;
    banner([
      "This database already held rows before the suites started:",
      `  ${dirty}`,
      "A failure below may be about that state rather than about your code.",
      "Some of it can be a sibling service's suites, running concurrently against this same",
      "database — `pnpm run test` starts them in parallel. To rule the database out entirely,",
      "reset it while nothing else is running:",
      "  pnpm run db:reset:local",
    ]);
  } catch (error) {
    // Never take a run down over its own diagnostics — the specs themselves report an unreachable database far
    // more clearly than this would.
    process.stderr.write(`\n[db-state-report] could not read the database: ${error.message}\n\n`);
  }
}

module.exports = { reportStateBeforeRun };
