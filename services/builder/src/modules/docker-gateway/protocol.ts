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

export type WorkspaceDescriptor = { id: string; root: string; leaves: WorkspaceLeaves };

/** Leaves only the runner writes; every other leaf is also written by the sandbox's own uid. */
export const RUNNER_ONLY_LEAVES: ReadonlySet<WorkspaceLeaf> = new Set(["source"]);
