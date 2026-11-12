import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type BindSourceCheck = { ok: true } | { ok: false; path: string; detail: string };

// The host daemon follows symlinks in a `-v` source, so each component below `root` must still be ours.
// `root` must never have been writable by a container, and nothing untrusted may be running at the call.
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
    if (uid !== undefined && info.uid !== uid) {
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
