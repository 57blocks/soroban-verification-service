/**
 * The dev server's API proxy: `VITE_DEV_API_PROXY=https://dev.sv.example.com` makes `pnpm run dev:web` serve a
 * deployed environment's API from the Vite origin, so the console can be debugged against real data without a
 * local backend.
 */

export class DevProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevProxyConfigError";
  }
}

/** Both API bases must be same-origin for their traffic to reach the proxy at all. */
const SAME_ORIGIN_ONLY = ["VITE_VERIFY_API_URL", "VITE_QUERY_API_URL"] as const;

const SET_TO_EMPTY =
  'set `VITE_VERIFY_API_URL=` (empty — it means "same origin", which is what the proxy serves)';

export type DevProxy = { target: string } | undefined;

/** Resolves the proxy target, or `undefined` when the variable is unset. */
export const resolveDevProxy = (env: Record<string, string | undefined>): DevProxy => {
  const target = env.VITE_DEV_API_PROXY?.trim();
  if (!target) return undefined;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new DevProxyConfigError(
      `VITE_DEV_API_PROXY is not a URL: ${target}\nExpected an origin, e.g. https://dev.sv.example.com`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DevProxyConfigError(
      `VITE_DEV_API_PROXY must be http or https, got ${url.protocol}${target}`,
    );
  }

  // A path on the target is prepended to the request's own `/api/...`, so `…/api/verification` here produces
  // `/api/verification/api/verification/v1/…` and 404s.
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new DevProxyConfigError(
      `VITE_DEV_API_PROXY must be an origin with no path, query or fragment: ${target}\n` +
        `The console adds /api/verification and /api/query itself. Use ${url.origin}`,
    );
  }

  // Unset is not empty: the console treats an absent base as "this bundle was built unconfigured" and renders a
  // configuration error instead of calling anything.
  if (env.VITE_VERIFY_API_URL === undefined) {
    throw new DevProxyConfigError(
      `VITE_DEV_API_PROXY is set, so ${SET_TO_EMPTY}.\n` +
        "Leaving it unset makes the console report itself as unconfigured.",
    );
  }

  const offenders = SAME_ORIGIN_ONLY.filter((name) => (env[name] ?? "") !== "");
  if (offenders.length > 0) {
    throw new DevProxyConfigError(
      `VITE_DEV_API_PROXY is set, so ${offenders.join(" and ")} must be empty — ` +
        `${offenders.map((name) => `${name}="${env[name]}"`).join(", ")}.\n` +
        "A non-empty base sends requests to that host directly and skips the proxy, " +
        "which a deployed environment then refuses on CORS.",
    );
  }

  return { target: url.origin };
};

/** Vite's `server.proxy` entry. */
export const devProxyServerConfig = (proxy: DevProxy) =>
  proxy
    ? {
        "/api": {
          target: proxy.target,
          changeOrigin: true,
          secure: true,
          ws: true,
        },
      }
    : undefined;

/**
 * Vite loads env files from `envDir`, which this package points at the repository root — so a
 * `clients/web/.env.local` is read by nothing and takes effect nowhere.
 */
const VITE_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
];

export const ignoredEnvFileWarning = (
  packageDir: string,
  envDir: string,
  exists: (path: string) => boolean,
): string | undefined => {
  // Nothing to warn about if this package *is* where Vite reads env from.
  if (normalizeDir(packageDir) === normalizeDir(envDir)) return undefined;

  const ignored = VITE_ENV_FILES.filter((name) => exists(`${normalizeDir(packageDir)}${name}`));
  if (ignored.length === 0) return undefined;

  return (
    `⚠  clients/web/{${ignored.join(",")}} ${ignored.length === 1 ? "exists and is" : "exist and are"} ignored.\n` +
    `   Vite's envDir is the repository root — move those values to ${normalizeDir(envDir)}.env.local`
  );
};

const normalizeDir = (dir: string) => (dir.endsWith("/") ? dir : `${dir}/`);
