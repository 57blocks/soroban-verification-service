#!/usr/bin/env node
/**
 * Does the dist-tag serving an environment resolve to a build of the commit that environment runs? Reads the
 * registry through npm (the package is public, so no login is involved) and the SDK surface through
 * git, and reports drift at the severity that environment's channel carries.
 *
 *   node eng-tools/assert-sdk-channel-alignment.mjs --env staging --deployed-commit <sha>
 */
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

/** Read through a throwaway cache so a stale packument cannot answer for the registry. */
const cache = mkdtempSync(join(tmpdir(), "scvs-alignment-"));
const ABSENT = /E404|no match(ing version)? found|is not in this registry/i;

/**
 * "" means the registry answered and has nothing under that name. A read that failed for any other reason —
 * no auth, no network, a 403 — is a hard failure, never an empty answer: reporting a broken read as
 * `unpublished` would turn this check into a warning that always passes.
 */
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

// Overridable so every verdict below can be exercised without a registry.
let publishedVersion = flag("published-version", "");
let publishedCommit = flag("published-commit", "");
let packageExists = flag("package-exists", "") !== "false";
if (publishedVersion) {
  rmSync(cache, { recursive: true, force: true });
} else {
  try {
    publishedVersion = view(`${PKG}@${channel.dist_tag}`, "version");
    if (publishedVersion) publishedCommit = view(`${PKG}@${publishedVersion}`, "scvs.gitSha");
    // Asked only when a dist-tag resolved to nothing, and it tells two different situations apart —
    // see the verdict below.
    else if (flag("package-exists", "") === "") packageExists = view(PKG, "name") !== "";
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

const short = (sha) => (sha ? git("rev-parse", "--short", sha) : "");
const fixCommand =
  channel.channel === "dev"
    ? `gh workflow run release.yml -f commit=${deployed}`
    : `gh workflow run release.yml -f version=vX.Y.Z-rc.N -f commit=${deployed}`;

/** `warn` keeps a deploy green and says so; `error` fails it. Both print the same one-command fix. */
function report(verdict, detail, override) {
  const aligned = verdict === "aligned";
  const raised = override ?? channel.severity;
  const severity = aligned ? "notice" : raised;
  // Releasing is not the fix for a package that cannot be published yet, and printing it as one sends
  // whoever reads this at a workflow that will skip its publish step.
  const fix = verdict === "unpublished" && override === "warn" ? "" : fixCommand;
  const headline = `${PKG}@${channel.dist_tag} · ${targetEnv} · ${verdict}`;

  console.log(`── env        ${targetEnv}`);
  console.log(`── dist-tag   \`${channel.dist_tag}\` → ${publishedVersion || "nothing"}`);
  console.log(`── built from ${publishedCommit ? short(publishedCommit) : "a commit it never recorded"}`);
  console.log(`── deployed   ${short(deployed)}`);
  console.log(`── verdict    ${verdict} — ${detail}`);

  if (fix) console.log(`── fix        ${fix}`);

  if (inGha) console.log(`::${severity}::${headline} — ${detail}${fix ? `. Fix: ${fix}` : ""}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### ${aligned ? "✅" : raised === "error" ? "❌" : "⚠️"} SDK channel \`${channel.dist_tag}\` vs ${targetEnv}`,
        "",
        "| | |",
        "| --- | --- |",
        `| dist-tag | \`${channel.dist_tag}\` → ${publishedVersion || "nothing"} |`,
        `| published from | ${publishedCommit ? `\`${short(publishedCommit)}\`` : "unrecorded"} |`,
        `| ${targetEnv} runs | \`${short(deployed)}\` |`,
        `| verdict | ${verdict} — ${detail} |`,
        "",
        ...(fix ? ["```bash", fix, "```", ""] : []),
      ].join("\n"),
    );
  }

  process.exit(aligned || raised === "warn" ? 0 : 1);
}

if (!publishedVersion && !packageExists) {
  // A name the registry has never seen is a different thing from a dist-tag left behind. Nothing can be
  // published while this repository is private — a trusted publish stamps provenance, and provenance is
  // verifiable only against a source anyone can read — so this is a decided state, not drift, and it must
  // not fail a staging deploy. It becomes an error again the moment the first version exists.
  report(
    "unpublished",
    `${PKG} is not on the registry at all, so nothing serves ${targetEnv} yet. Expected until this repository is public`,
    "warn",
  );
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

// Everything below diffs the two commits, which needs both of them here — a published commit that has left
// the repository cannot be compared, and saying so beats a raw git error.
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
