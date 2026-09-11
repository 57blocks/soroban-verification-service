import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm-workspace.yaml` rather than `.git` as the marker: this has to keep working in a source tarball with no
 * VCS metadata, and in a `git worktree` where `.git` is a file rather than a directory.
 */
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

/** Walks up from **this module's own location**, not from `process.cwd()`. */
export function findWorkspaceRoot(startFrom?: string): string | undefined {
  let dir = startFrom ?? dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Absolute path of the shared `.env`, or `undefined` outside a workspace checkout. */
export function rootEnvFilePath(): string | undefined {
  const root = findWorkspaceRoot();
  return root ? join(root, ".env") : undefined;
}

/** The `envFilePath` array for `ConfigModule.forRoot`, in precedence order. */
export function envFilePaths(): string[] {
  return [".env", rootEnvFilePath()].filter(
    (path): path is string => path !== undefined
  );
}
