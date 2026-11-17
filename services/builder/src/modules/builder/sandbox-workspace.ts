import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_ONLY_LEAVES,
  WORKSPACE_LEAVES,
  WORKSPACES_PATH,
  type PrefetchEgress,
  type WorkspaceDescriptor,
  type WorkspaceLeaf,
  type WorkspaceLeaves,
} from "../docker-gateway/protocol.js";
import { socketCall } from "../docker-gateway/socket-call.js";
import type { SandboxWrites } from "./run-cli.types.js";

const GATEWAY_READY_POLL_MS = 200;

/** Set where the runner reaches the host's daemon only through the docker gateway, as every deployed job does. */
export function dockerGatewaySocket(): string | undefined {
  return process.env.SCVS_DOCKER_GATEWAY?.trim() || undefined;
}

/**
 * `prefetch` is set through the gateway: the internal network the prefetch stage joins and the proxy that is its
 * only way out. Without the gateway the prefetch stage takes Docker's default bridge, as local development does.
 */
export type SandboxWorkspace = { root: string; leaves: WorkspaceLeaves; prefetch?: PrefetchEgress };

/**
 * The directories one rebuild binds into its sandbox containers. Through the gateway they sit under a root
 * the runner cannot write, so the runner can fill them but not swap one for a link before a stage starts.
 */
export async function createSandboxWorkspace(input: {
  workDirs: string[];
  sandboxWrites?: SandboxWrites;
}): Promise<SandboxWorkspace> {
  const socket = dockerGatewaySocket();
  if (socket) {
    const response = await socketCall(socket, "POST", WORKSPACES_PATH);
    const workspace = response.body as WorkspaceDescriptor | undefined;
    if (response.status !== 201 || !workspace?.id) {
      throw new Error(`the docker gateway did not create a sandbox workspace (${response.status})`);
    }
    input.sandboxWrites?.workspaces?.push(workspace.id);
    if (!workspace.prefetch?.network || !workspace.prefetch.proxy) {
      throw new Error("the docker gateway offers no prefetch network, so dependencies cannot be fetched");
    }
    return { root: workspace.root, leaves: workspace.leaves, prefetch: workspace.prefetch };
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), "scvs-sandbox-")));
  input.workDirs.push(root);
  const leaves = {} as Record<WorkspaceLeaf, string>;
  for (const [leaf, name] of Object.entries(WORKSPACE_LEAVES) as [WorkspaceLeaf, string][]) {
    const path = join(root, name);
    await mkdir(path);
    // The sandbox runs as its own uid; the root stays 0700, so no other host user reaches these.
    if (!RUNNER_ONLY_LEAVES.has(leaf)) {
      await chmod(path, 0o777);
      input.sandboxWrites?.dirs.push(path);
    }
    leaves[leaf] = path;
  }
  return { root, leaves };
}

/** Deletes each gateway workspace, sandbox-owned files included. Returns the ids it could not delete. */
export async function releaseGatewayWorkspaces(ids: readonly string[]): Promise<string[]> {
  const socket = dockerGatewaySocket();
  if (!socket) return [...ids];
  const failed: string[] = [];
  for (const id of ids) {
    const response = await socketCall(socket, "DELETE", `${WORKSPACES_PATH}/${id}`).catch(() => undefined);
    if (response?.status !== 204) failed.push(id);
  }
  return failed;
}

/** The gateway is a sibling container that may still be starting when the runner does. */
export async function waitForDockerGateway(timeoutMs: number): Promise<boolean> {
  const socket = dockerGatewaySocket();
  if (!socket) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await socketCall(socket, "GET", "/_ping").catch(() => undefined);
    if (response?.status === 200) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, GATEWAY_READY_POLL_MS));
  }
}
