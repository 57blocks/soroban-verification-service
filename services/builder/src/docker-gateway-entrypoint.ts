#!/usr/bin/env node
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { ScvsLogger, stderrOnlySink } from "@scvs/core";
import { runCommand } from "@scvs/core/process";
import { SANDBOX_USER } from "./modules/builder/run-cli.config.js";
import { DockerGateway } from "./modules/docker-gateway/gateway.js";
import { encodeRegistryAuth } from "./modules/docker-gateway/policy.js";
import { emptyInContainer } from "./modules/docker-gateway/upstream.js";
import { WorkspaceStore, type WorkspaceOwner } from "./modules/docker-gateway/workspaces.js";

/** The host's root daemon. The gateway is the only container in the job that mounts it. */
const HOST_DOCKER_SOCKET = "/var/run/docker.sock";
const RUNNER_ACCOUNT = "node";
const ECR_TOKEN_TIMEOUT_MS = 30_000;

const logger = new ScvsLogger("docker-gateway", { sink: stderrOnlySink });

async function main(): Promise<void> {
  const socket = required("SCVS_DOCKER_GATEWAY", process.env.SCVS_DOCKER_GATEWAY);
  const image = required("SCVS_DOCKER_GATEWAY_IMAGE", process.env.SCVS_DOCKER_GATEWAY_IMAGE);
  if (process.getuid?.() !== 0) {
    throw new Error("the docker gateway must run as root: it makes the workspaces the runner may not rename");
  }
  const runner = account(RUNNER_ACCOUNT);
  const parent = realpathSync(tmpdir());
  requireUnrenamable(parent);

  mkdirSync(dirname(socket), { recursive: true });
  rmSync(socket, { force: true });
  const gateway = new DockerGateway({
    upstreamSocket: HOST_DOCKER_SOCKET,
    workspaces: new WorkspaceStore({ parent, runner, empty: emptyInContainer(HOST_DOCKER_SOCKET, image) }),
    sandboxUser: SANDBOX_USER,
    log: (event, fields) => logger.log(event, fields),
    ecrAuth: ecrRegistryAuth,
  });
  await gateway.listen(socket);
  chownSync(socket, runner.uid, runner.gid);
  chmodSync(socket, 0o600);
  logger.log("gateway_listening", { socket, workspace_parent: parent });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      gateway
        .shutdown()
        .catch((error: unknown) => logger.error("gateway_shutdown_failed", { detail: String(error) }))
        .finally(() => process.exit(0));
    });
  }
}

/**
 * An ECR token from the host's instance role. The hosts drop the job's own containers' traffic to the metadata
 * service, so this root process is the only one in the job that can fetch it.
 */
async function ecrRegistryAuth(registry: { host: string; region: string }): Promise<string> {
  const token = await runCommand(["aws", "ecr", "get-login-password", "--region", registry.region], {
    timeout_ms: ECR_TOKEN_TIMEOUT_MS,
    // stdout is a registry credential.
    mirrorOutput: false,
    record: false,
  });
  if (token.exit_code !== 0 || !token.stdout.trim()) {
    throw new Error(`aws ecr get-login-password exited ${token.exit_code ?? "without a code"}: ${token.stderr.slice(0, 300)}`);
  }
  return encodeRegistryAuth({ username: "AWS", password: token.stdout.trim(), serveraddress: registry.host });
}

function required(name: string, raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function account(name: string): WorkspaceOwner {
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === name && uid && gid) return { uid: Number(uid), gid: Number(gid) };
  }
  throw new Error(`no ${name} account in /etc/passwd`);
}

/** Root's, and sticky if anyone else may write it: otherwise the runner could rename a workspace root away. */
function requireUnrenamable(path: string): void {
  const info = lstatSync(path);
  const othersWrite = (info.mode & 0o022) !== 0;
  const sticky = (info.mode & 0o1000) !== 0;
  if (info.uid !== 0 || (othersWrite && !sticky)) {
    throw new Error(`${path} lets another user rename what is in it (uid ${info.uid}, mode ${(info.mode & 0o7777).toString(8)})`);
  }
}

main().catch((error: unknown) => {
  logger.error("gateway_failed", { detail: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
