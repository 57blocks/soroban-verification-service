/** Shared by the gateway and the runner: the gateway's own endpoints, beside the Docker API it filters. */

export const WORKSPACES_PATH = "/scvs/v1/workspaces";

/** One directory per mount a sandbox stage takes. Each is a direct child of a root the runner cannot write. */
export const WORKSPACE_LEAVES = {
  source: "source",
  vendor: "vendor",
  out: "out",
  cargoHome: "cargo-home",
  artifact: "artifact",
} as const;

export type WorkspaceLeaf = keyof typeof WORKSPACE_LEAVES;
export type WorkspaceLeaves = Record<WorkspaceLeaf, string>;

/** `prefetch` is the network a prefetch stage in this workspace joins, and the proxy it reaches out through. */
export type WorkspaceDescriptor = { id: string; root: string; leaves: WorkspaceLeaves; prefetch?: PrefetchEgress };

/** Leaves only the runner writes; every other leaf is also written by the sandbox's own uid. */
export const RUNNER_ONLY_LEAVES: ReadonlySet<WorkspaceLeaf> = new Set(["source"]);

/**
 * The only network a prefetch stage may join. It is internal, so it has no route off the host; its one other
 * member is the egress proxy, which tunnels to allowlisted hosts only.
 */
export type PrefetchEgress = { network: string; proxy: string };

/** The proxy's name on the prefetch network, and the port it listens on. */
export const EGRESS_PROXY_ALIAS = "scvs-egress-proxy";
export const EGRESS_PROXY_PORT = 3128;
