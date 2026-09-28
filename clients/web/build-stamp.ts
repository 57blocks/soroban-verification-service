import type { Plugin } from "vite";

export const BUILD_META_NAME = "build";

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
  return `${date}.${commit.slice(0, 7)}`;
};

export const buildStampPlugin = (
  env: Record<string, string | undefined> = process.env,
): Plugin => {
  const content = buildStamp(env.SCVS_BUILD_COMMIT, env.SCVS_BUILD_DATE);
  return {
    name: "scvs-build-stamp",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: BUILD_META_NAME, content }, injectTo: "head" },
    ],
  };
};
