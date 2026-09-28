export class DevProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevProxyConfigError";
  }
}

const SAME_ORIGIN_ONLY = ["VITE_VERIFY_API_URL", "VITE_QUERY_API_URL"] as const;

const SET_TO_EMPTY =
  'set `VITE_VERIFY_API_URL=` (empty — it means "same origin", which is what the proxy serves)';

export type DevProxy = { target: string } | undefined;

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

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new DevProxyConfigError(
      `VITE_DEV_API_PROXY must be an origin with no path, query or fragment: ${target}\n` +
        `The console adds /api/verification and /api/query itself. Use ${url.origin}`,
    );
  }

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
  if (normalizeDir(packageDir) === normalizeDir(envDir)) return undefined;

  const ignored = VITE_ENV_FILES.filter((name) => exists(`${normalizeDir(packageDir)}${name}`));
  if (ignored.length === 0) return undefined;

  return (
    `⚠  clients/web/{${ignored.join(",")}} ${ignored.length === 1 ? "exists and is" : "exist and are"} ignored.\n` +
    `   Vite's envDir is the repository root — move those values to ${normalizeDir(envDir)}.env.local`
  );
};

const normalizeDir = (dir: string) => (dir.endsWith("/") ? dir : `${dir}/`);
