/**
 * Renders the nginx `location` allowlist that serves the console's entry document, from
 * `src/app/route-paths.ts`. Emitted into the bundle at build time so the served config cannot drift from
 * the route tree; `docker/web.Dockerfile` moves it out of the document root.
 */
import type { Plugin } from "vite";
import { CONSOLE_ROUTE_PATHS } from "./src/app/route-paths.ts";

export const SPA_ROUTES_CONF = "spa-routes.conf";

export class SpaRoutesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaRoutesError";
  }
}

const PARAM = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

const escapeRegex = (segment: string) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A path's nginx matcher: `= /exact` where it has no parameters, `~ ^…$` where it has. A parameter matches
 * one segment, so `/verify/jobs/a/b` is not a route and 404s.
 */
export const locationMatcher = (path: string): string => {
  if (!path.startsWith("/")) {
    throw new SpaRoutesError(`route path must be absolute, got "${path}"`);
  }
  const segments = path === "/" ? [] : path.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw new SpaRoutesError(`route path "${path}" has an empty segment`);
    }
    // A splat would have to match any depth, which this renderer does not express — and a wrong guess here
    // is a route that 404s only in the deployed image.
    if (segment === "$" || segment === "*") {
      throw new SpaRoutesError(
        `route path "${path}" is a splat, which spa-routes.ts cannot render — teach it, or the ` +
          `deployed origin will 404 every path under it`,
      );
    }
    if (segment.startsWith("$") && !PARAM.test(segment)) {
      throw new SpaRoutesError(`route path "${path}" has an unreadable parameter "${segment}"`);
    }
  }
  if (!segments.some((segment) => segment.startsWith("$"))) return `= ${path}`;
  const pattern = segments
    .map((segment) => (segment.startsWith("$") ? "[^/]+" : escapeRegex(segment)))
    .join("/");
  return `~ ^/${pattern}$`;
};

export const renderSpaRoutesConf = (paths: readonly string[] = CONSOLE_ROUTE_PATHS): string => {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throw new SpaRoutesError(`route path "${path}" is listed twice`);
    seen.add(path);
  }
  const matchers = paths.map(locationMatcher);
  // Exact before regex, which is nginx's own precedence — written in that order so the file reads the way
  // it matches.
  const ordered = [
    ...matchers.filter((m) => m.startsWith("= ")).sort(),
    ...matchers.filter((m) => m.startsWith("~ ")).sort(),
  ];
  const width = Math.max(...ordered.map((m) => m.length));
  return [
    "# Generated from clients/web/src/app/route-paths.ts by clients/web/spa-routes.ts. Do not edit.",
    "# Every console route serves the entry document. Anything not matched here and not a real file 404s.",
    ...ordered.map((m) => `location ${m.padEnd(width)} { try_files /index.html =404; }`),
    "",
  ].join("\n");
};

export const spaRoutesPlugin = (): Plugin => ({
  name: "scvs-spa-routes",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: SPA_ROUTES_CONF, source: renderSpaRoutesConf() });
  },
});
