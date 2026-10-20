#!/usr/bin/env node
/** Asserts an environment's SDK dist-tag resolves to a build of the commit it runs. npm + git; no login. */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVIRONMENT_CHANNELS,
  SDK_SURFACE,
  UNBUILT_ENVIRONMENT_CHANNELS,
  fail,
  git,
  inGha,
  isCommitPresent,
  sdkSurfaceDiff,
} from "./release-channels.mjs";

const PKG = "soroban-verification-client";
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const targetEnv = flag("env", process.env.SCVS_ENV ?? "dev");
const deployed = (flag("deployed-commit", process.env.SCVS_DEPLOYED_COMMIT) ?? "").trim();

const channel = ENVIRONMENT_CHANNELS[targetEnv];
if (!channel) {
  const unbuilt = UNBUILT_ENVIRONMENT_CHANNELS[targetEnv];
  fail(
    unbuilt
      ? `${targetEnv} has a designed channel (\`${unbuilt.dist_tag}\`) but no environment to assert it against yet`
      : `${targetEnv} is not an environment with a release channel — known: ${Object.keys(ENVIRONMENT_CHANNELS).join(", ")}`,
  );
}

if (!deployed) fail("--deployed-commit is required: it is the commit the environment's running image was built from");
if (!isCommitPresent(deployed)) {
  fail(`${deployed} is not a commit in this checkout, so nothing can be proved about it — fetch the full history`);
}

/** A throwaway cache, so a stale packument cannot answer for the registry. */
const cache = mkdtempSync(join(tmpdir(), "scvs-alignment-"));
const ABSENT = /E404|no match(ing version)? found|is not in this registry/i;

/** "" means the registry has nothing under that name; any other read failure is fatal, never "". */
function view(spec, field) {
  try {
    return execFileSync("npm", ["view", spec, field, "--prefer-online", "--cache", cache], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (ABSENT.test(output)) return "";
    rmSync(cache, { recursive: true, force: true });
    fail(`could not read ${spec} from the registry: ${output.split("\n").slice(-3).join(" / ") || error.message}`);
  }
}

let publishedVersion = flag("published-version", "");
let publishedCommit = flag("published-commit", "");
if (publishedVersion) {
  rmSync(cache, { recursive: true, force: true });
} else {
  try {
    publishedVersion = view(`${PKG}@${channel.dist_tag}`, "version");
    if (publishedVersion) publishedCommit = view(`${PKG}@${publishedVersion}`, "scvs.gitSha");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

const short = (sha) => (sha ? git("rev-parse", "--short", sha) : "");
const fixCommand =
  channel.channel === "dev"
    ? `gh workflow run release.yml -f commit=${deployed}`
    : `gh workflow run release.yml -f version=vX.Y.Z-rc.N -f commit=${deployed}`;

function report(verdict, detail) {
  const aligned = verdict === "aligned";
  const severity = aligned ? "notice" : channel.severity;
  const headline = `${PKG}@${channel.dist_tag} · ${targetEnv} · ${verdict}`;

  console.log(`── env        ${targetEnv}`);
  console.log(`── dist-tag   \`${channel.dist_tag}\` → ${publishedVersion || "nothing"}`);
  console.log(`── built from ${publishedCommit ? short(publishedCommit) : "a commit it never recorded"}`);
  console.log(`── deployed   ${short(deployed)}`);
  console.log(`── verdict    ${verdict} — ${detail}`);

  console.log(`── fix        ${fixCommand}`);

  if (inGha) console.log(`::${severity}::${headline} — ${detail}. Fix: ${fixCommand}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### ${aligned ? "✅" : channel.severity === "error" ? "❌" : "⚠️"} SDK channel \`${channel.dist_tag}\` vs ${targetEnv}`,
        "",
        "| | |",
        "| --- | --- |",
        `| dist-tag | \`${channel.dist_tag}\` → ${publishedVersion || "nothing"} |`,
        `| published from | ${publishedCommit ? `\`${short(publishedCommit)}\`` : "unrecorded"} |`,
        `| ${targetEnv} runs | \`${short(deployed)}\` |`,
        `| verdict | ${verdict} — ${detail} |`,
        "",
        "```bash",
        fixCommand,
        "```",
        "",
      ].join("\n"),
    );
  }

  process.exit(aligned || channel.severity === "warn" ? 0 : 1);
}

if (!publishedVersion) {
  report("unpublished", `no version carries the \`${channel.dist_tag}\` dist-tag, so no consumer of ${targetEnv} can install one`);
}

if (!publishedCommit) {
  report(
    "unprovable",
    `${publishedVersion} records no commit, so it cannot be shown to match ${targetEnv} — supersede it with a version that does`,
  );
}

if (publishedCommit === deployed) {
  report("aligned", `${publishedVersion} was built from the commit ${targetEnv} runs`);
}

if (!isCommitPresent(publishedCommit)) {
  report(
    "unprovable",
    `${publishedVersion} records commit ${publishedCommit.slice(0, 7)}, which is not in this checkout, so it ` +
      `cannot be compared with ${targetEnv}'s ${short(deployed)}`,
  );
}

const changed = sdkSurfaceDiff(publishedCommit, deployed);
if (changed.length === 0) {
  report(
    "aligned",
    `${publishedVersion} was built from ${short(publishedCommit)}, a different commit, but nothing under ` +
      `${SDK_SURFACE.join(", ")} differs from ${short(deployed)} — the tarball would be the same`,
  );
}

const direction = isAncestor(publishedCommit, deployed) ? "behind" : "ahead of";
report(
  "drifted",
  `${publishedVersion} was built from ${short(publishedCommit)}, which is ${direction} ${targetEnv}'s ` +
    `${short(deployed)} by ${changed.length} file(s) under the SDK surface, including ${changed[0]}`,
);

function isAncestor(maybeAncestor, descendant) {
  try {
    git("merge-base", "--is-ancestor", maybeAncestor, descendant);
    return true;
  } catch {
    return false;
  }
}
