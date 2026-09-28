#!/usr/bin/env node
/** Empties the **local** test database's job-related tables. */
import { execFileSync } from "node:child_process";

const host = process.env.POSTGRES_HOST ?? "localhost";
const port = process.env.POSTGRES_PORT ?? "5433";
const database = process.env.POSTGRES_DB ?? "scvs";
const user = process.env.POSTGRES_USER ?? "scvs";
const password = process.env.POSTGRES_PASSWORD ?? "scvs_local_dev";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
if (!LOCAL_HOSTS.has(host)) {
  console.error(
    `refusing to truncate: POSTGRES_HOST is "${host}", which is not loopback.\n` +
      `This script exists to clean a developer's local container and nothing else. If you meant to ` +
      `point it at a remote database, you did not.`,
  );
  process.exit(2);
}

const TABLES = ["jobs", "rebuilds", "uploads", "abuse_control"];

const CONTAINER = process.env.SCVS_POSTGRES_CONTAINER ?? "scvs-postgres";
let transport;

const run = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const psql = (sql) => {
  if (transport === undefined) {
    try {
      run("psql", ["--version"]);
      transport = "local";
    } catch {
      transport = "docker";
      console.log(`psql not on PATH — using the "${CONTAINER}" container instead`);
    }
  }
  return transport === "local"
    ? run("psql", [`postgresql://${user}:${password}@${host}:${port}/${database}`, "-tAc", sql])
    : run("docker", ["exec", CONTAINER, "psql", "-U", user, "-d", database, "-tAc", sql]);
};

try {
  const before = TABLES.map((table) => `${table}=${psql(`select count(*) from ${table};`)}`);
  psql(`truncate ${TABLES.join(", ")} cascade;`);
  console.log(`✓ truncated ${TABLES.join(", ")} on ${host}:${port}/${database}`);
  console.log(`  was: ${before.join("  ")}`);
} catch (error) {
  const detail = (error.stderr || error.message).toString().trim();
  console.error(`could not reset ${host}:${port}/${database}: ${detail}`);
  console.error(
    `\nTried ${transport === "docker" ? `the "${CONTAINER}" container` : "the local psql"}. If the ` +
      `container is not running: docker compose -f docker/docker-compose.yml up -d`,
  );
  process.exit(1);
}
