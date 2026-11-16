import { chmod, chown, mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { RUNNER_ONLY_LEAVES, WORKSPACE_LEAVES, type WorkspaceDescriptor, type WorkspaceLeaf } from "./protocol.js";

export type WorkspaceOwner = { uid: number; gid: number };

const ROOT_PREFIX = "scvs-sandbox-";

export type WorkspaceStoreOptions = {
  /** A directory whose entries the runner cannot rename: root's, and sticky if anyone else may write it. */
  parent: string;
  /** The runner's uid and gid; set when the gateway runs as root, so the root stays root's. */
  runner?: WorkspaceOwner;
  /** Deletes everything inside a workspace root without following any link a container or the runner left. */
  empty: (root: string) => Promise<void>;
};

/**
 * Sandbox bind sources the runner can write into but never swap. Each leaf is a direct child of a root-owned
 * root the runner may only traverse, so no leaf can be renamed or replaced by a symlink between the gateway's
 * check and the daemon's mount.
 */
export class WorkspaceStore {
  private readonly live = new Map<string, WorkspaceDescriptor>();
  private readonly leafOwner = new Map<string, string>();

  constructor(private readonly options: WorkspaceStoreOptions) {}

  async create(): Promise<WorkspaceDescriptor> {
    const { runner } = this.options;
    const root = await mkdtemp(join(this.options.parent, ROOT_PREFIX));
    const id = basename(root).slice(ROOT_PREFIX.length);
    if (runner) await chown(root, 0, runner.gid);
    await chmod(root, 0o750);
    const leaves = {} as Record<WorkspaceLeaf, string>;
    for (const [leaf, name] of Object.entries(WORKSPACE_LEAVES) as [WorkspaceLeaf, string][]) {
      const path = join(root, name);
      await mkdir(path);
      if (runner) await chown(path, runner.uid, runner.gid);
      // The sandbox runs as its own uid, so the leaves it writes are open to it; the root above them is not.
      await chmod(path, RUNNER_ONLY_LEAVES.has(leaf) ? 0o755 : 0o777);
      leaves[leaf] = path;
    }
    const workspace = { id, root, leaves };
    this.live.set(id, workspace);
    for (const path of Object.values(leaves)) this.leafOwner.set(path, id);
    return workspace;
  }

  workspaceOfLeaf(path: string): string | undefined {
    const id = this.leafOwner.get(path);
    return id !== undefined && this.live.has(id) ? id : undefined;
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  /** Forgets the workspace first, so no container can be created or started against it while it is emptied. */
  async delete(id: string): Promise<boolean> {
    const workspace = this.live.get(id);
    if (!workspace) return false;
    this.live.delete(id);
    for (const path of Object.values(workspace.leaves)) this.leafOwner.delete(path);
    await this.options.empty(workspace.root);
    await rmdir(workspace.root);
    return true;
  }
}

/** For a gateway that is not root and shares the runner's uid, as in tests: no link here can reach anything more. */
export async function emptyInProcess(root: string): Promise<void> {
  for (const entry of await readdir(root)) await rm(join(root, entry), { recursive: true, force: true });
}
