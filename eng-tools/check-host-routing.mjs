#!/usr/bin/env node
/** Serves `docker/web-nginx.conf` on real nginx in a throwaway container and probes each position. Needs Docker; no AWS. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSpaRoutesConf } from "../clients/web/spa-routes.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const IMAGE = readFileSync(join(repoRoot, "docker/web.Dockerfile"), "utf8").match(/^FROM (nginx:\S+)$/m)?.[1];
if (!IMAGE) throw new Error("docker/web.Dockerfile has no `FROM nginx:<tag>` line to test against");

const SHELL_MARKER = "<title>scvs-host-routing-probe</title>";
const DOCS_MARKER = "<title>scvs-host-routing-docs-probe</title>";
const DOCS_404_MARKER = "<title>scvs-host-routing-docs-404-probe</title>";

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
  { path: "/docs/", status: 200, type: "text/html", docs: DOCS_MARKER, why: "the documentation site's home" },
  { path: "/docs", status: 301, location: "/docs/", why: "relative, or a balancer terminating TLS turns it into http://" },
  {
    path: "/docs/introduction/how-it-works",
    status: 200,
    type: "text/html",
    docs: DOCS_MARKER,
    why: "a clean URL serves its .html file",
  },
  {
    path: "/docs/introduction/missing",
    status: 404,
    type: "text/html",
    docs: DOCS_404_MARKER,
    why: "a missing page is the documentation site's own 404, not the console's",
  },
  { path: "/docs/assets/style-deadbeef.css", status: 200, type: "text/css", why: "a hashed documentation asset" },
  { path: "/docsearch", status: 404, type: "text/html", shell: true, why: "only /docs/ belongs to the documentation site" },
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

const dockerfile = readFileSync(join(repoRoot, "docker/web.Dockerfile"), "utf8");
if (!/mv\s+\/usr\/share\/nginx\/html\/spa-routes\.conf\s+\/etc\/nginx\/scvs\//.test(dockerfile)) {
  fail(
    "docker/web.Dockerfile does not move spa-routes.conf out of /usr/share/nginx/html — the bundle emits " +
      "it there, and `try_files $uri` would serve the origin's own nginx config to anyone who asks"
  );
}

const workdir = mkdtempSync(join(tmpdir(), "scvs-host-routing-"));
const docroot = join(workdir, "html");
mkdirSync(join(docroot, "assets"), { recursive: true });
writeFileSync(join(docroot, "index.html"), `<!doctype html><html><head>${SHELL_MARKER}</head></html>\n`);
writeFileSync(join(docroot, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
writeFileSync(join(docroot, "assets", "app-deadbeef.js"), "export const x = 1;\n");
mkdirSync(join(docroot, "docs", "introduction"), { recursive: true });
mkdirSync(join(docroot, "docs", "assets"), { recursive: true });
writeFileSync(join(docroot, "docs", "index.html"), `<!doctype html><html><head>${DOCS_MARKER}</head></html>\n`);
writeFileSync(
  join(docroot, "docs", "introduction", "how-it-works.html"),
  `<!doctype html><html><head>${DOCS_MARKER}</head></html>\n`
);
writeFileSync(join(docroot, "docs", "404.html"), `<!doctype html><html><head>${DOCS_404_MARKER}</head></html>\n`);
writeFileSync(join(docroot, "docs", "assets", "style-deadbeef.css"), "body{}\n");
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

  for (const { path, status, type, shell, docs, location, why } of EXPECTATIONS) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    const because = why ? ` (${why})` : "";
    if (response.status !== status) {
      fail(`${path} answers ${response.status}, expected ${status}${because}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (type && !contentType.includes(type)) {
      fail(`${path} answers content-type "${contentType}", expected ${type}${because}`);
    }
    if (location !== undefined && response.headers.get("location") !== location) {
      fail(`${path} redirects to "${response.headers.get("location")}", expected "${location}"${because}`);
    }
    if (docs) {
      const body = await response.text();
      if (!body.includes(docs)) {
        fail(`${path} does not carry the expected documentation page${because}`);
      }
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

  for (const method of ["POST", "DELETE", "PUT"]) {
    const response = await fetch(`${origin}/admin/policy`, { method, redirect: "manual" });
    if (response.status !== 404) {
      fail(`${method} /admin/policy answers ${response.status}, expected 404 on every method`);
    }
  }

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
  const docsPage = await fetch(`${origin}/docs/introduction/how-it-works`);
  const docsCache = docsPage.headers.get("cache-control") ?? "";
  if (!docsCache.includes("no-cache")) {
    fail(`/docs/ serves a page with cache-control "${docsCache}", expected no-cache: it names hashed assets`);
  }
  if (!(docsPage.headers.get("x-robots-tag") ?? "").includes("noindex")) {
    fail("/docs/ serves a page without the host's X-Robots-Tag");
  }
  const docsAsset = await fetch(`${origin}/docs/assets/style-deadbeef.css`);
  const docsAssetCache = docsAsset.headers.get("cache-control") ?? "";
  if (!docsAssetCache.includes("immutable")) {
    fail(`/docs/assets/ serves a hashed asset with cache-control "${docsAssetCache}", expected immutable`);
  }
  if (!(docsAsset.headers.get("x-robots-tag") ?? "").includes("noindex")) {
    fail("/docs/assets/ drops the host's X-Robots-Tag — add_header in a location replaces every inherited one");
  }
} finally {
  stop();
}

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);

console.log(
  findings.length
    ? `\n${findings.length} deviation(s) from what docs/specs/configuration.md §5 says the default target ` +
        `answers. The routes come from clients/web/src/app/route-paths.ts; the rest is docker/web-nginx.conf.`
    : `✓ ${EXPECTATIONS.length} position(s) answer as docs/specs/configuration.md §5 states: a console route serves ` +
        `the entry document, a real file serves itself, /docs/ is the documentation site, everything else 404s`
);
process.exit(findings.length ? 1 : 0);
