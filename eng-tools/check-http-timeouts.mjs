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

const APPLY_CALL = /\bapplyHttpServerTimeouts\s*\(/;
const LISTEN_CALL = /\bapp\.listen\s*\(/;

const findings = [];
const serving = [];

for (const service of readdirSync(SERVICES).sort()) {
  const main = join(SERVICES, service, "src/main.ts");
  if (!existsSync(main)) continue;

  const source = readFileSync(main, "utf8");
  if (!LISTEN_CALL.test(source)) continue;

  serving.push(relative(ROOT, main));
  if (!APPLY_CALL.test(source)) {
    findings.push(
      `${relative(ROOT, main)} binds a port but never calls applyHttpServerTimeouts(). Without it the server ` +
        `takes Node's defaults, whose 5s keepAliveTimeout sits below the load balancer's idle timeout and ` +
        `answers 502 on a reused connection. See docs/invariants.md rule 33.`,
    );
  }
}

if (serving.length === 0) {
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
