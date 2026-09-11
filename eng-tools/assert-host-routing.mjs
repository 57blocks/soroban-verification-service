#!/usr/bin/env node
/**
 * Black-box: asserts a deployed origin answers every position `docs/design/aws-deployment.md` §4 names. No
 * credentials of any kind — HTTPS only, which is why it can run on a deploy runner and from a runbook alike.
 *
 *   node eng-tools/assert-host-routing.mjs --env dev [--origin https://…]
 */
import { ERROR_SCHEMA, ERROR_SCHEMA_VERSION } from "../packages/core/src/error-envelope.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const targetEnv = flag("env", process.env.SCVS_ENV ?? "dev");
const origin = (flag("origin", process.env.SCVS_HOST_ORIGIN) ?? `https://${targetEnv}.sv.example.com`)
  .replace(/\/+$/, "");

/** Scoped to this run so no cached answer for it can predate the deploy being asserted. */
const nonce = `scvs-routing-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const findings = [];
const fail = (message) => findings.push(message);

/** Takes a path on the target origin, or an absolute URL for the plaintext probe. */
const ask = async (target, method = "GET") => {
  const url = target.startsWith("http") ? target : `${origin}${target}`;
  try {
    const response = await fetch(url, { method, redirect: "manual" });
    return {
      url,
      method,
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      location: response.headers.get("location") ?? "",
      body: await response.text(),
    };
  } catch (error) {
    return { url, method, status: 0, type: "", location: "", body: "", error };
  }
};

const describe = (probe) => `${probe.method} ${probe.url}`;

/** Reports the reachability failure once, so an unreachable host is one line and not one line per probe. */
const reachable = (probe) => {
  if (probe.status !== 0) return true;
  fail(`${describe(probe)} did not answer: ${probe.error?.message ?? "unknown error"}`);
  return false;
};

const expect = (probe, { status, type }) => {
  if (!reachable(probe)) return false;
  let ok = true;
  if (probe.status !== status) {
    fail(`${describe(probe)} answers ${probe.status}, expected ${status}`);
    ok = false;
  }
  if (type && !probe.type.includes(type)) {
    fail(`${describe(probe)} answers content-type "${probe.type}", expected ${type}`);
    ok = false;
  }
  return ok;
};

/** Every 4xx inside `/api/` carries the same four fields, whichever hop produced it. */
const expectEnvelope = (probe, producedBy) => {
  let body;
  try {
    body = JSON.parse(probe.body);
  } catch {
    fail(`${describe(probe)} does not answer JSON — ${producedBy} owns this position`);
    return;
  }
  const missing = ["schema", "schema_version", "error", "message"].filter((key) => !body[key]);
  if (missing.length) {
    fail(
      `${describe(probe)} answers a body missing ${missing.join(", ")} — ${producedBy} produces it, and ` +
        `every error body on this host carries the same four fields (packages/core/src/error-envelope.ts)`
    );
    return;
  }
  if (body.schema !== ERROR_SCHEMA || body.schema_version !== ERROR_SCHEMA_VERSION) {
    fail(
      `${describe(probe)} answers schema "${body.schema}" v"${body.schema_version}", expected ` +
        `"${ERROR_SCHEMA}" v"${ERROR_SCHEMA_VERSION}" (${producedBy})`
    );
  }
};

console.log(`Checking ${origin} (${targetEnv})`);

// ── the console: its routes serve the shell, everything else at the root does not ───────────────

expect(await ask("/"), { status: 200, type: "text/html" });
expect(await ask("/verify"), { status: 200, type: "text/html" });
expect(await ask(`/verify/jobs/${nonce}`), { status: 200, type: "text/html" });
expect(await ask("/healthz"), { status: 200, type: "text/plain" });

// The status is the whole discriminator: HTML is a legitimate answer at this origin, a 200 for a path
// nothing routes is not.
for (const path of [`/${nonce}`, "/admin/policy", "/docs-json", "/verify/submit"]) {
  expect(await ask(path), { status: 404, type: "text/html" });
}

// A POST used to be refused by nginx with 405 text/html, which points a reader at the web config rather than
// at the routing.
const posted = await ask(`/${nonce}`, "POST");
if (reachable(posted) && posted.status === 405) {
  fail(`${describe(posted)} answers 405 — the default target is refusing the method instead of the path`);
}

// ── `/api/`: the two services' namespaces, and the rule that closes the rest ────────────────────

for (const [path, producedBy] of [
  [`/api/verification/v1/${nonce}`, "verification-svc's catch-all controller"],
  [`/api/query/v1/${nonce}`, "query-svc's catch-all controller"],
  [`/api/${nonce}`, "the ALB's fixed-response rule"],
]) {
  const probe = await ask(path);
  if (expect(probe, { status: 404, type: "application/json" })) expectEnvelope(probe, producedBy);
}

// ── the two documents whose healthy answer is also `200 text/html` ──────────────────────────────

for (const [service, title] of [
  ["verification", "Soroban Verification API"],
  ["query", "Soroban Query API"],
]) {
  const docs = await ask(`/api/${service}/v1/docs`);
  if (expect(docs, { status: 200, type: "text/html" }) && !docs.body.includes(`<title>${title}</title>`)) {
    const seen = docs.body.match(/<title>([^<]*)<\/title>/)?.[1] ?? "no title";
    fail(
      `${describe(docs)} serves "${seen}", expected "${title}" — the status and content-type cannot tell ` +
        `Swagger UI apart from the console, so the title is what does`
    );
  }

  const spec = await ask(`/api/${service}/v1/openapi.json`);
  if (expect(spec, { status: 200, type: "application/json" })) {
    let paths;
    try {
      paths = Object.keys(JSON.parse(spec.body).paths ?? {});
    } catch {
      paths = [];
    }
    if (paths.length === 0) {
      fail(`${describe(spec)} carries no paths — anything reading it would pass without reading a document`);
    }
  }
}

// ── plaintext upgrades rather than serving ──────────────────────────────────────────────────────

const plain = await ask(`${origin.replace(/^https:/, "http:")}/${nonce}`);
if (reachable(plain)) {
  if (plain.status !== 301) {
    fail(`${describe(plain)} answers ${plain.status}, expected a 301 — :80 must serve nothing at all`);
  } else if (!plain.location.startsWith("https://")) {
    fail(`${describe(plain)} redirects to "${plain.location}", expected an https:// target`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────

const inGha = Boolean(process.env.GITHUB_ACTIONS);
for (const f of findings) console.log(inGha ? `::error::${f}` : `  ✗ ${f}`);

console.log(
  findings.length
    ? `\n${findings.length} deviation(s) from docs/design/aws-deployment.md §4. Every position here is ` +
        `black-box, so a red run means a client sees this too.`
    : `✓ ${origin} answers §4 at every position: each service its own namespace, /api/ closed with an ` +
        `envelope, the console's routes served, everything else 404`
);
process.exit(findings.length ? 1 : 0);
