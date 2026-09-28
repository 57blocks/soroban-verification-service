#!/usr/bin/env node
/** Refuses a deploy from a ref that is not an ancestor of main. Pure git, no credentials. */
import { fail, git, inGha, requireOnMain } from "./release-channels.mjs";

const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const targetEnv = flag("env", process.env.SCVS_ENV ?? "dev");
// Under `workflow_call` GITHUB_SHA names the caller's commit, so the checkout's HEAD comes first.
const sha = flag("sha") ?? tryGit("rev-parse", "HEAD") ?? process.env.GITHUB_SHA;
if (!sha) fail("no commit to check: pass --sha, or run this where a checkout or GITHUB_SHA exists");

const comparedAgainst = requireOnMain({
  sha,
  subject: `the ${targetEnv} deploy`,
  act: "deploy",
  main: flag("main"),
});

console.log(`── env       ${targetEnv}`);
console.log(`── commit    ${git("rev-parse", "--short", sha)}`);
console.log(`── on main   proved against ${comparedAgainst}`);

if (inGha && process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Deploy ref\n\n\`${git("rev-parse", "--short", sha)}\` is an ancestor of ${comparedAgainst}.\n\n`,
  );
}
