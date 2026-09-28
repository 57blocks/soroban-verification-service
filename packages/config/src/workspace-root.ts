import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `pnpm-workspace.yaml`, not `.git`: must work in a source tarball and in a `git worktree`. */
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

export function rootEnvFilePath(): string | undefined {
  const root = findWorkspaceRoot();
  return root ? join(root, ".env") : undefined;
}

export function envFilePaths(): string[] {
  return [".env", rootEnvFilePath()].filter(
    (path): path is string => path !== undefined
  );
}
