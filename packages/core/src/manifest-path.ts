import { isAbsolute, posix } from "node:path";
import { unescapeShellWord } from "./shell-words.js";
import type { RebuildErrorCode } from "./rebuild-error-code.js";

/** The `--manifest-path` a `bldopt` array records, as written. */
export function extractManifestPath(bldopt?: string[]): string | undefined {
  // An unparsable entry is dropped, not substituted — same as the replay path's own unescapeBldoptEntries, so
  // an index-based lookahead here lines up with what replay actually sees.
  const tokens: string[] = [];
  for (const raw of bldopt ?? []) {
    const parsed = unescapeShellWord(raw);
    if (parsed.ok) tokens.push(parsed.word);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--manifest-path") {
      return tokens[index + 1];
    }
    const inline = token.match(/^--manifest-path=(.+)$/);
    if (inline) {
      return inline[1];
    }
  }
  return undefined;
}

/** The manifest path as it will be passed **inside** the sandbox, under `/source`. */
export function resolveContainerManifestPath(
  workspacePath: string,
): { ok: true; path: string } | { ok: false; reason: RebuildErrorCode; detail: string } {
  const raw = workspacePath || ".";
  if (isAbsolute(raw)) {
    return {
      ok: false,
      reason: "absolute_manifest_path_not_supported",
      detail:
        "Manual-evidence Docker rebuild requires a manifest path relative to the submitted source archive root.",
    };
  }
  const manifest = raw === "." || raw === ""
    ? "Cargo.toml"
    : raw.endsWith("Cargo.toml")
      ? raw
      : posix.join(raw, "Cargo.toml");
  // Normalised first, then checked: a leading `..` survives normalisation and is the escape.
  const normalised = posix.normalize(manifest);
  if (normalised === ".." || normalised.startsWith("../")) {
    return {
      ok: false,
      reason: "manifest_path_escapes_source",
      detail:
        `The recorded manifest path resolves to ${normalised}, outside the mounted source tree. ` +
        "A recipe whose manifest lies outside the submitted source cannot be replayed.",
    };
  }
  return { ok: true, path: posix.join("/source", normalised) };
}
