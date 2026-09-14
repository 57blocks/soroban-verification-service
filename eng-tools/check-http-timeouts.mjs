#!/usr/bin/env node
/** Static: reads each service's `src/main.ts` and talks to nothing. No AWS, no credentials, no network. */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SERVICES = join(ROOT, "services");

if (!existsSync(SERVICES)) {
  console.error("no services/ — run this from the repository root");
  process.exit(2);
}

/**
 * The thing that can regress is a `main.ts` that binds a port and never configures the server's deadlines. That
 * lives past `listen()`, inside the `NODE_ENV !== "test"` arm no test executes — which is why this is a static
 * check and not a spec.
 */
const APPLY_CALL = /\bapplyHttpServerTimeouts\s*\(/;
const LISTEN_CALL = /\bapp\.listen\s*\(/;

const findings = [];
/** Discovered, not enumerated: a fourth serving entrypoint is covered the day it is added. */
const serving = [];

for (const service of readdirSync(SERVICES).sort()) {
  const main = join(SERVICES, service, "src/main.ts");
  if (!existsSync(main)) continue;

  const source = readFileSync(main, "utf8");
  if (!LISTEN_CALL.test(source)) continue; // not a serving entrypoint — the builder and composer are one-shot jobs

  serving.push(relative(ROOT, main));
  if (!APPLY_CALL.test(source)) {
    findings.push(
      `${relative(ROOT, main)} binds a port but never calls applyHttpServerTimeouts(). Without it the server ` +
        `takes Node's defaults, whose 5s keepAliveTimeout sits below the load balancer's idle timeout and ` +
        `answers 502 on a reused connection. See docs/invariants.md rule 32.`,
    );
  }
}

if (serving.length === 0) {
  // An empty pass is indistinguishable from a passing check, and this one has been silently satisfiable before:
  // a refactor that renames main.ts or the listen call would otherwise report success over nothing.
  console.error("check:http-timeouts matched no serving entrypoint — the discovery patterns are stale");
  process.exit(2);
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`✗ ${finding}`);
  process.exit(1);
}

console.log(
  `✓ http server timeouts applied — ${serving.length} serving entrypoint(s) checked: ${serving.join(", ")}`,
);
