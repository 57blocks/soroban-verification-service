#!/usr/bin/env node
/**
 * Static inputs, real nginx: serves `docker/web-nginx.conf` and the generated route allowlist over a synthetic
 * document root in a throwaway container, then probes what each position answers. No AWS, no network beyond
 * the image pull.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSpaRoutesConf } from "../clients/web/spa-routes.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The base `docker/web.Dockerfile` builds on, so this tests the config on the runtime that serves it. */
const IMAGE = "nginx:1.27-alpine";

/** Recognisable enough that a body assertion cannot pass on nginx's own error page. */
const SHELL_MARKER = "<title>scvs-host-routing-probe</title>";

/**
 * One expectation per position the host answers. `html` means the console's entry document — at 200 for a
 * route, at 404 for everything else.
 */
const EXPECTATIONS = [
  { path: "/", status: 200, type: "text/html", shell: true, why: "the landing page" },
  { path: "/healthz", status: 200, type: "text/plain", why: "the load balancer's target" },
  { path: "/verify", status: 200, type: "text/html", shell: true },
  { path: "/verify/jobs/9f2c-abc", status: 200, type: "text/html", shell: true, why: "a job deep link" },
  { path: "/terms", status: 200, type: "text/html", shell: true },
  { path: "/privacy", status: 200, type: "text/html", shell: true },
  { path: "/query", status: 200, type: "text/html", shell: true, why: "routed whether or not its flag is on" },
  { path: "/logo.svg", status: 200, type: "image/svg+xml", why: "a real file at the root" },
  {
    path: "/assets/app-deadbeef.js",
    status: 200,
    type: "javascript",
    why: "a hashed asset — its prefix location must beat every generated regex",
  },
  { path: "/admin/policy", status: 404, type: "text/html", shell: true, why: "an auditor's probe position" },
  { path: "/docs-json", status: 404, type: "text/html", shell: true, why: "a path that was renamed away" },
  {
    path: "/verify/submit",
    status: 404,
    type: "text/html",
    shell: true,
    why: "the console route retired when the landing page became the root",
  },
  {
    path: "/verify/jobs/9f2c/extra",
    status: 404,
    type: "text/html",
    shell: true,
    why: "a route parameter matches one segment",
  },
  { path: "/verify/jobs/", status: 404, type: "text/html", shell: true, why: "an empty route parameter" },
  {
    path: "/verify/anything",
    status: 404,
    type: "text/html",
    shell: true,
    why: "an exact route does not cover its sub-paths",
  },
  { path: "/assets/renamed.js", status: 404, why: "a hashed asset that moved must not answer 200" },
  {
    path: "/api/verification/v1/health",
    status: 404,
    type: "text/html",
    shell: true,
    why: "nothing routes /api/ here, and a lost ALB rule must land on a 404 rather than a 200",
  },
];

const findings = [];
const fail = (message) => findings.push(message);

const docker = (...argv) =>
  execFileSync("docker", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  docker("version", "--format", "{{.Server.Version}}");
} catch (error) {
  console.error(
    `✗ this check serves the real config on ${IMAGE} and needs a running Docker daemon: ` +
      `${String(error.stderr ?? "").trim() || error.message}`
  );
  process.exit(1);
}

// ── the generated allowlist must not be reachable as a static file ──────────────────────────────

const dockerfile = readFileSync(join(repoRoot, "docker/web.Dockerfile"), "utf8");
if (!/mv\s+\/usr\/share\/nginx\/html\/spa-routes\.conf\s+\/etc\/nginx\/scvs\//.test(dockerfile)) {
  fail(
    "docker/web.Dockerfile does not move spa-routes.conf out of /usr/share/nginx/html — the bundle emits " +
      "it there, and `try_files $uri` would serve the origin's own nginx config to anyone who asks"
  );
}

// ── a synthetic document root: one of each thing the real bundle carries ────────────────────────

const workdir = mkdtempSync(join(tmpdir(), "scvs-host-routing-"));
const docroot = join(workdir, "html");
mkdirSync(join(docroot, "assets"), { recursive: true });
writeFileSync(join(docroot, "index.html"), `<!doctype html><html><head>${SHELL_MARKER}</head></html>\n`);
writeFileSync(join(docroot, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
writeFileSync(join(docroot, "assets", "app-deadbeef.js"), "export const x = 1;\n");
const spaRoutes = join(workdir, "spa-routes.conf");
writeFileSync(spaRoutes, renderSpaRoutesConf());

const mounts = [
  "-v", `${docroot}:/usr/share/nginx/html:ro`,
  "-v", `${join(repoRoot, "docker/web-nginx.conf")}:/etc/nginx/conf.d/default.conf:ro`,
  "-v", `${spaRoutes}:/etc/nginx/scvs/spa-routes.conf:ro`,
];

let container;
const stop = () => {
  if (container) docker("rm", "-f", container);
  rmSync(workdir, { recursive: true, force: true });
};

try {
  // Parsed before anything is served, so a syntax error or an unresolved include reports as itself rather
  // than as eighteen failed probes.
  try {
    docker("run", "--rm", ...mounts, IMAGE, "nginx", "-t");
  } catch (error) {
    const detail = String(error.stderr ?? error.stdout ?? "").trim() || error.message;
    console.error(`✗ nginx refuses docker/web-nginx.conf:\n${detail}`);
    process.exit(1);
  }

  container = docker("run", "-d", "-p", "127.0.0.1:0:80", ...mounts, IMAGE);
  const mapped = docker("port", container, "80/tcp");
  const port = Number(mapped.split("\n")[0].split(":").pop());
  const origin = `http://127.0.0.1:${port}`;

  // The daemon binds within a few hundred milliseconds; poll rather than sleep a guessed amount.
  let up = false;
  for (let attempt = 0; attempt < 50 && !up; attempt += 1) {
    try {
      up = (await fetch(`${origin}/healthz`)).ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!up) {
    console.error(`✗ nginx never answered on ${origin}\n${docker("logs", container)}`);
    process.exit(1);
  }

  for (const { path, status, type, shell, why } of EXPECTATIONS) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    const because = why ? ` (${why})` : "";
    if (response.status !== status) {
      fail(`${path} answers ${response.status}, expected ${status}${because}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (type && !contentType.includes(type)) {
      fail(`${path} answers content-type "${contentType}", expected ${type}${because}`);
    }
    if (shell) {
      const body = await response.text();
      if (!body.includes(SHELL_MARKER)) {
        fail(
          `${path} does not carry the console's entry document${because} — error_page must deliver it, ` +
            `so that a 404 here is the console's own page and not nginx's`
        );
      }
    }
  }

  // Every method, because E2E-SEC-14 asserts a management path answers 404 from an auditor's position and
  // 405 there would read as "something is here, and it refused you".
  for (const method of ["POST", "DELETE", "PUT"]) {
    const response = await fetch(`${origin}/admin/policy`, { method, redirect: "manual" });
    if (response.status !== 404) {
      fail(`${method} /admin/policy answers ${response.status}, expected 404 on every method`);
    }
  }

  // The one header that is not about routing but is delivered by it: try_files serves index.html without
  // re-matching a location, so a per-location no-cache would be bypassed for every route above.
  const shellCache = (await fetch(`${origin}/verify`)).headers.get("cache-control") ?? "";
  if (!shellCache.includes("no-cache")) {
    fail(
      `/verify serves the entry document with cache-control "${shellCache}" — it names the current asset ` +
        `hashes, so a cached copy points at files a later deploy has removed`
    );
  }
  const assetCache = (await fetch(`${origin}/assets/app-deadbeef.js`)).headers.get("cache-control") ?? "";
  if (!assetCache.includes("immutable")) {
    fail(`/assets/ serves a hashed asset with cache-control "${assetCache}", expected immutable`);
  }
} finally {
  stop();
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);

console.log(
  findings.length
    ? `\n${findings.length} deviation(s) from what docs/design/aws-deployment.md §4 says the default target ` +
        `answers. The routes come from clients/web/src/app/route-paths.ts; the rest is docker/web-nginx.conf.`
    : `✓ ${EXPECTATIONS.length} position(s) answer as §4's default-target row states: a console route serves ` +
        `the entry document, a real file serves itself, everything else 404s`
);
process.exit(findings.length ? 1 : 0);
