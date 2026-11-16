import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type BindSourceCheck = { ok: true } | { ok: false; path: string; detail: string };

// The host daemon follows symlinks in a bind source, so each component below `root` must still be ours.
// `root` must never have been writable by a container, and nothing untrusted may be running at the call; a
// root the docker gateway made is root's, which no container or runner can be.
export async function requireBindSource(path: string, root: string): Promise<BindSourceCheck> {
  const below = relative(root, path);
  if (below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) {
    return { ok: false, path, detail: `${path} is not inside the job directory ${root}.` };
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let current = root;
  for (const segment of ["", ...below.split(sep).filter(Boolean)]) {
    current = segment ? join(current, segment) : current;
    const info = await lstat(current).catch(() => undefined);
    if (!info) return { ok: false, path, detail: `${current} no longer exists.` };
    if (info.isSymbolicLink()) return { ok: false, path, detail: `${current} was replaced by a symbolic link.` };
    if (!info.isDirectory()) return { ok: false, path, detail: `${current} is no longer a directory.` };
    if (uid !== undefined && info.uid !== uid && !(current === root && info.uid === 0)) {
      return { ok: false, path, detail: `${current} is owned by uid ${info.uid}, not by the runner.` };
    }
  }

  const resolved = await realpath(path).catch(() => undefined);
  if (resolved !== path) {
    return { ok: false, path, detail: `${path} resolves to ${resolved ?? "nothing"}, not to itself.` };
  }
  return { ok: true };
}

export async function requireBindSources(
  sources: ReadonlyArray<{ path: string; root: string }>,
): Promise<BindSourceCheck> {
  for (const source of sources) {
    const check = await requireBindSource(source.path, source.root);
    if (!check.ok) return check;
  }
  return { ok: true };
}

/**
 * A non-recursive bind: `-v` would carry the source's submounts (/proc, /sys, /run) along, and would create a
 * missing source as an empty root-owned directory instead of failing.
 */
export function bindMount(source: string, target: string, options: { readOnly?: boolean } = {}): string[] {
  if (/[,"\n]/.test(source) || /[,"\n]/.test(target)) throw new Error(`bind mount path cannot be expressed in --mount: ${source}`);
  return [
    "--mount",
    `type=bind,source=${source},target=${target}${options.readOnly ? ",readonly" : ""},bind-recursive=disabled`,
  ];
}
