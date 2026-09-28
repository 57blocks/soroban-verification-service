#!/usr/bin/env node
/** Static: credentialed jobs prove their ref is on main first and keep `${{ inputs.* }}` out of `run:`. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DIR = ".github/workflows";
const CREDS = "configure-aws-credentials";
const ASSERT = "assert-deploy-ref";
const BASELINE_FILE = new URL("./credentialed-job-inputs.json", import.meta.url);
const BASELINE_NAME = "eng-tools/credentialed-job-inputs.json";
const INPUT_EXPRESSION = /\$\{\{[^}]*\binputs\.[A-Za-z0-9_]+[^}]*\}\}/g;

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const stepsOf = (job) => (job?.steps ?? []).filter((s) => s && typeof s === "object");
const firstIndex = (job, pred) => stepsOf(job).findIndex(pred);
const isCreds = (s) => String(s.uses ?? "").includes(CREDS);
const isAssert = (s) => String(s.run ?? "").includes(ASSERT);

function guardsItself(job) {
  const assertAt = firstIndex(job, isAssert);
  if (assertAt === -1) return false;
  const credsAt = firstIndex(job, isCreds);
  return credsAt === -1 || assertAt < credsAt;
}

let failures = 0;
const sites = [];
const observed = {};
for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const path = join(DIR, file);
  let doc;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`  ✗ ${path} — cannot parse: ${error.message}`);
    failures += 1;
    continue;
  }
  const jobs = doc?.jobs ?? {};

  for (const [name, job] of Object.entries(jobs)) {
    const credsSteps = stepsOf(job).filter(isCreds);
    if (credsSteps.length === 0) continue;

    for (const [index, step] of stepsOf(job).entries()) {
      for (const hit of String(step.run ?? "").match(INPUT_EXPRESSION) ?? []) {
        const counts = (observed[file] ??= {});
        counts[name] = (counts[name] ?? 0) + 1;
        sites.push({ file, job: name, step: step.name ?? `step ${index + 1}`, hit: hit.replace(/\s+/g, " ") });
      }
    }

    if (guardsItself(job)) continue;

    const seen = new Set();
    const stack = asList(job.needs);
    let inherited = false;
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      if (guardsItself(jobs[n])) {
        inherited = true;
        break;
      }
      stack.push(...asList(jobs[n]?.needs));
    }
    if (inherited) continue;

    // Every credentials step must be gated; one ungated step is enough to leak them.
    if (credsSteps.every((s) => String(s.if ?? "").includes("inputs.on_main"))) continue;

    const assertAt = firstIndex(job, isAssert);
    const why =
      assertAt === -1
        ? `it never runs ${ASSERT}, no job it needs does, and its credentials are not gated on inputs.on_main`
        : `it runs ${ASSERT} at step ${assertAt + 1}, AFTER its first ${CREDS} at step ${firstIndex(job, isCreds) + 1}`;
    console.error(`  ✗ ${path} — job '${name}' assumes an AWS role but ${why}`);
    failures += 1;
  }
}

// Report both checks before exiting, so the first cannot hide the second.
let unproven = false;
if (failures) {
  console.error(
    `\n${failures} credentialed job(s) unproven. Put \`node eng-tools/assert-deploy-ref.mjs --sha <ref>\` ` +
      `before the credentials step, depend on a job that does, or gate the credentials on \`inputs.on_main\`.`,
  );
  unproven = true;
} else {
  console.log(`✓ every job that assumes an AWS role proves its ref is on main first, or takes no credentials`);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
const pending = baseline.pending ?? {};
const findings = [];

for (const [file, jobs] of Object.entries(observed)) {
  for (const [job, count] of Object.entries(jobs)) {
    const allowed = pending[file]?.[job] ?? 0;
    if (count <= allowed) continue;
    const where = sites
      .filter((s) => s.file === file && s.job === job)
      .map((s) => `      ${s.step}: ${s.hit}`)
      .join("\n");
    findings.push(
      (allowed === 0
        ? `${DIR}/${file} — job '${job}' holds AWS credentials and interpolates ${count} input ` +
          `expression(s) into a \`run:\` body, and nothing authorises any here`
        : `${DIR}/${file} — job '${job}' interpolates ${count} input expression(s) into a \`run:\` body, ` +
          `baseline allows ${allowed}. The baseline only shrinks`) + `\n${where}`,
    );
  }
}

for (const [file, jobs] of Object.entries(pending)) {
  for (const [job, allowed] of Object.entries(jobs)) {
    const count = observed[file]?.[job] ?? 0;
    if (count >= allowed) continue;
    findings.push(
      `${BASELINE_NAME} allows ${allowed} in ${file} job '${job}' and only ${count} remain — lower it ` +
        `to ${count} (or drop the entry) so the ratchet holds`,
    );
  }
}

if (process.argv.includes("--write-baseline")) {
  const shrunk = {};
  for (const [file, jobs] of Object.entries(pending)) {
    for (const [job, allowed] of Object.entries(jobs)) {
      const count = Math.min(observed[file]?.[job] ?? 0, allowed);
      if (count > 0) (shrunk[file] ??= {})[job] = count;
    }
  }
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ ...baseline, pending: Object.fromEntries(Object.entries(shrunk).sort()) }, null, 2)}\n`,
  );
  console.log(`✓ ${BASELINE_NAME} rewritten from the tree; it can only ever shrink`);
  process.exit(0);
}

if (findings.length) {
  for (const finding of findings) console.error(`  ✗ ${finding}`);
  console.error(
    `\n${findings.length} finding(s). Pass the value through \`env:\` and read it as a quoted shell ` +
      `variable, then lower the entry in ${BASELINE_NAME}.`,
  );
  process.exit(1);
}
if (unproven) process.exit(1);

const remaining = Object.values(pending).reduce(
  (n, jobs) => n + Object.values(jobs).reduce((m, c) => m + c, 0),
  0,
);
console.log(
  `✓ no credentialed job interpolates an input into a \`run:\` body beyond the ${remaining} ` +
    `occurrence(s) the baseline still allows`,
);
