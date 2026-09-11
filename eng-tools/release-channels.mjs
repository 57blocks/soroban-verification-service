/**
 * The release channel table, and the git proof a release depends on. One module owns both so that the
 * resolver, the deploy-ref guard and the channel-alignment assertion cannot drift apart.
 */
import { execFileSync } from "node:child_process";

export const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PRERELEASE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)$/;

/**
 * Which dist-tag serves each deployment environment. A channel is a pointer, not a per-environment build:
 * the package is environment-agnostic, so an environment is aligned when the version behind its dist-tag was
 * built from the commit it runs.
 */
export const ENVIRONMENT_CHANNELS = {
  dev: { channel: "dev", dist_tag: "dev", severity: "warn" },
  staging: { channel: "staging", dist_tag: "staging", severity: "error" },
};

/** Designed and deliberately not wired: no `prod` environment exists in either repository yet. */
export const UNBUILT_ENVIRONMENT_CHANNELS = {
  prod: { channel: "stable", dist_tag: "latest", severity: "error" },
};

/**
 * What the published tarball is actually made of. `packages/core` and `packages/storage-layout` are in the
 * list because tsup's `noExternal` and api-extractor's `bundledPackages` compile both INTO `dist` — a change
 * there changes the artifact even when `clients/sdk` is untouched. `clients/sdk/README.md` ships too (it is
 * in `files`), so the whole directory counts.
 */
export const SDK_SURFACE = ["clients/sdk", "packages/core", "packages/storage-layout"];

export const inGha = Boolean(process.env.GITHUB_ACTIONS);

export function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** The files two commits differ by under the SDK surface. Throws when either commit is not in the checkout. */
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

/**
 * A working copy may carry a personal fork as `origin` alongside the real repository, so the remote is chosen
 * by URL when CI names one. Whichever ref answers is returned: comparing against the wrong main silently is
 * the one failure this check must not have.
 */
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
      // Try the next spelling.
    }
  }
  return null;
}

/**
 * The substitute for branch protection, which this repository cannot have: the org is on the free plan, so
 * `branches/main/protection` answers 403 and a ref can otherwise point at any commit in the repository.
 * Returns the ref it compared against, so a caller can print what it proved.
 */
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
