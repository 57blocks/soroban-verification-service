#!/usr/bin/env node
/**
 * Refuses a job that assumes an AWS role without first proving the ref it is running is on main.
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
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DIR = ".github/workflows";
const CREDS = "configure-aws-credentials";
const ASSERT = "assert-deploy-ref";

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

    if (guardsItself(job)) continue;

    // Rule 2. An assertion in an ancestor is load-bearing because a failed `needs` skips this job.
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

    // Rule 3. Every one of them, not just the first: one unconditioned step is the whole hole.
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

if (failures) {
  console.error(
    `\n${failures} credentialed job(s) unproven. Put \`node eng-tools/assert-deploy-ref.mjs --sha <ref>\` ` +
      `before the credentials step, depend on a job that does, or gate the credentials on \`inputs.on_main\`.`,
  );
  process.exit(1);
}
console.log(`✓ every job that assumes an AWS role proves its ref is on main first, or takes no credentials`);
