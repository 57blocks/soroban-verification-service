#!/usr/bin/env node
import { ScvsLogger, stderrOnlySink } from "@scvs/core";
import { prefetchAllowedHosts } from "./modules/builder/run-cli.config.js";
import { EGRESS_PROXY_PORT } from "./modules/docker-gateway/protocol.js";
import { createEgressProxy } from "./modules/egress-proxy/egress-proxy.js";

/**
 * The prefetch stage's egress proxy. The docker gateway runs it in its own container, as the sandbox's uid, on
 * the job's internal prefetch network and on a bridge with a route out.
 */
const logger = new ScvsLogger("egress-proxy", { sink: stderrOnlySink });

function main(): void {
  if (process.getuid?.() === 0) throw new Error("the egress proxy does not run as root");
  const allowedHosts = prefetchAllowedHosts();
  const server = createEgressProxy({ allowedHosts, log: (event, fields) => logger.log(event, fields) });
  server.listen(EGRESS_PROXY_PORT, "0.0.0.0", () => {
    // The gateway waits for this line before it lets a prefetch stage start.
    logger.log("egress_proxy_listening", { port: EGRESS_PROXY_PORT, allowed_hosts: allowedHosts.join(",") });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

try {
  main();
} catch (error) {
  logger.error("egress_proxy_failed", { detail: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
