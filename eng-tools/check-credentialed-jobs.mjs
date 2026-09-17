#!/usr/bin/env node
/**
 * Two rules over the jobs that assume an AWS role.
 *
 * Rule 1 refuses a job that assumes an AWS role without first proving the ref it is running is on main.
 *
 * The pipeline is pull-based: the operations repository hands this one a ref, this one checks it out and
 * runs it. `assert-deploy-ref.mjs` is what makes that safe, and it is only worth anything when it runs
 * BEFORE the credentials — after them the untrusted tree has already had them.
 *
 * A job satisfies the rule three ways:
 *   1. it runs the assertion itself, at a step index below its first credentials step;
 *   2. a job it transitively `needs` does — a failed `needs` skips this one;
 *   3. every credentials step in it is conditioned on `inputs.on_main`, the graded path: a ref that is
 *      not on main still runs, and gets no credentials at all.
 *
 * Rule 2 refuses `${{ inputs.* }}` inside the `run:` of such a job. An expression is substituted into the
 * shell's source text before the shell ever sees it, so a crafted input is code, not a value; `env:` plus
 * a quoted shell variable is the form that is not. A `workflow_call` input can only be declared `string`,
 * `boolean` or `number` — the `choice` enumerations that constrain today's callers live on their dispatch
 * surfaces, not in this contract, and a different caller inherits none of them.
 *
 * Rule 2 is a ratchet against `credentialed-job-inputs.json`, not an allowlist: a job may hold no more
 * than the baseline records, a job the baseline does not name may hold none, and an entry above reality
 * is stale. `-- --write-baseline` can only shrink it.
 */
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

/** Rule 1, including the ordering the whole thing turns on. */
function guardsItself(job) {
  const assertAt = firstIndex(job, isAssert);
  if (assertAt === -1) return false;
  const credsAt = firstIndex(job, isCreds);
  return credsAt === -1 || assertAt < credsAt;
}

let failures = 0;
/** Every rule-2 occurrence, so a failure can name the step it is in. */
const sites = [];
/** file → job → number of `${{ inputs.* }}` occurrences in that job's `run:` bodies. */
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

    // Rule 2's inventory. Credentials are per-job, so a job that only `needs` a credentialed one holds none.
    for (const [index, step] of stepsOf(job).entries()) {
      for (const hit of String(step.run ?? "").match(INPUT_EXPRESSION) ?? []) {
        const counts = (observed[file] ??= {});
        counts[name] = (counts[name] ?? 0) + 1;
        sites.push({ file, job: name, step: step.name ?? `step ${index + 1}`, hit: hit.replace(/\s+/g, " ") });
      }
    }

    if (guardsItself(job)) continue;

    // Way 2. An assertion in an ancestor is load-bearing because a failed `needs` skips this job.
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

    // Way 3. Every one of them, not just the first: one unconditioned step is the whole hole.
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

// Both rules report before either exits: a rule-1 failure must not hide a rule-2 one.
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

// ── Rule 2: the expression may not reach the script ─────────────────────────────────────────────
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
