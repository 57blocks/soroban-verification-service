import { dockerGatewaySocket } from "./sandbox-workspace.js";

const DOCKER_CLI_VARIABLES = [
  "PATH",
  "HOME",
  "DOCKER_CONFIG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

/** The docker CLI copies a bare `-e NAME` from its own environment, so it gets only what reaching the daemon needs. */
export function dockerCliOptions(): { env: NodeJS.ProcessEnv; inheritEnv: false } {
  const env: NodeJS.ProcessEnv = {};
  for (const name of DOCKER_CLI_VARIABLES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  // Through the gateway, nothing else may name another daemon.
  const gateway = dockerGatewaySocket();
  if (gateway) {
    for (const name of ["DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) delete env[name];
    env.DOCKER_HOST = `unix://${gateway}`;
  }
  return { env, inheritEnv: false };
}
