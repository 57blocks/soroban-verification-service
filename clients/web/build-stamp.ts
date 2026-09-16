/**
 * The console's build stamp — `<commit date>.<7-character commit>` — injected into the entry document as
 * `<meta name="build">`. `.dockerignore` excludes `.git`, so `docker/web.Dockerfile` passes both halves in
 * as build arguments rather than the build reading them itself.
 */
import type { Plugin } from "vite";

export const BUILD_META_NAME = "build";

/** What a build with no stamp carries: a local `vite build`, which has no deployment to be newer than. */
export const UNSTAMPED = "dev";

const COMMIT = /^[0-9a-f]{7,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class BuildStampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildStampError";
  }
}

export const buildStamp = (commit?: string, date?: string): string => {
  if (!commit && !date) return UNSTAMPED;
  // Half a stamp is a wiring mistake, and whatever it rendered would read like a real one.
  if (!commit || !date) {
    throw new BuildStampError(
      `SCVS_BUILD_COMMIT and SCVS_BUILD_DATE are set together or not at all, got ` +
        `commit="${commit ?? ""}" date="${date ?? ""}"`,
    );
  }
  if (!COMMIT.test(commit)) {
    throw new BuildStampError(`SCVS_BUILD_COMMIT is not a commit: "${commit}"`);
  }
  if (!DATE.test(date)) {
    throw new BuildStampError(`SCVS_BUILD_DATE is not a YYYY-MM-DD date: "${date}"`);
  }
  // Seven characters, never the whole commit: the page is served from a public origin while the repository
  // is private.
  return `${date}.${commit.slice(0, 7)}`;
};

export const buildStampPlugin = (
  env: Record<string, string | undefined> = process.env,
): Plugin => {
  // Resolved when the config loads, so a malformed stamp stops the build before it produces a bundle.
  const content = buildStamp(env.SCVS_BUILD_COMMIT, env.SCVS_BUILD_DATE);
  return {
    name: "scvs-build-stamp",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: BUILD_META_NAME, content }, injectTo: "head" },
    ],
  };
};
