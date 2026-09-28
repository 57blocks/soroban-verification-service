/** The release channel table, and the git proof a release depends on. */
import { execFileSync } from "node:child_process";

export const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PRERELEASE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)$/;

export const ENVIRONMENT_CHANNELS = {
  dev: { channel: "dev", dist_tag: "dev", severity: "warn" },
  staging: { channel: "staging", dist_tag: "staging", severity: "error" },
};

export const UNBUILT_ENVIRONMENT_CHANNELS = {
  prod: { channel: "stable", dist_tag: "latest", severity: "error" },
};

/** Paths the tarball is built from: tsup bundles `packages/core` and `packages/storage-layout` into `dist`. */
export const SDK_SURFACE = ["clients/sdk", "packages/core", "packages/storage-layout"];

export const inGha = Boolean(process.env.GITHUB_ACTIONS);

export function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function sdkSurfaceDiff(from, to) {
  return git("diff", "--name-only", `${from}..${to}`, "--", ...SDK_SURFACE).split("\n").filter(Boolean);
}

export function isCommitPresent(commit) {
  try {
    git("rev-parse", "--verify", `${commit}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

export function fail(reason) {
  console.log(inGha ? `::error::${reason}` : `  ✗ ${reason}`);
  process.exit(1);
}

export function mainRef(explicit) {
  if (explicit) return explicit;

  const slug = process.env.GITHUB_REPOSITORY;
  if (slug) {
    for (const remote of git("remote").split("\n").filter(Boolean)) {
      if (git("remote", "get-url", remote).includes(slug)) return `${remote}/main`;
    }
  }

  for (const candidate of ["origin/main", "main"]) {
    try {
      git("rev-parse", "--verify", `${candidate}^{commit}`);
      return candidate;
    } catch {
    }
  }
  return null;
}

export function requireOnMain({ sha, subject, act, main: explicitMain }) {
  const main = mainRef(explicitMain);
  if (!main) {
    fail(`cannot resolve main, so ${subject} could not be proved to ${act} reviewed code — fetch it before this step`);
  }
  const comparedAgainst = `${main} (${git("rev-parse", "--short", main)})`;
  try {
    git("merge-base", "--is-ancestor", sha, main);
  } catch {
    fail(
      `${subject} points at ${sha.slice(0, 7)}, which is not an ancestor of ${comparedAgainst} — a ${act} is ` +
        `cut from main, never from a branch. Pass \`--main <ref>\` if this checkout compares against the wrong remote`,
    );
  }
  return comparedAgainst;
}
