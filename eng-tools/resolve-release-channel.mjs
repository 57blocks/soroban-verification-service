#!/usr/bin/env node
/**
 * The one place that decides what a git ref releases. Runnable locally against any ref
 * (`--ref refs/tags/v0.2.0`) so the rule can be read before a tag is pushed, not after.
 *
 * | ref                      | channel | version                    | dist-tag | assets |
 * | ------------------------ | ------- | -------------------------- | -------- | ------ |
 * | `refs/heads/main`        | dev     | `<next>-dev.<n>.g<sha>`    | dev      | no     |
 * | `refs/tags/vX.Y.Z-<pre>` | staging | `X.Y.Z-<pre>`              | staging  | yes    |
 * | `refs/tags/vX.Y.Z`       | stable  | `X.Y.Z`                    | latest   | yes    |
 * | anything else            | none    | —                          | —        | no     |
 *
 * A dispatched run has no tag (`github.ref` is a branch), so the dispatch's `version` input is read as if
 * it were the tag name — `v0.1.2` or `0.1.2`, the `v` normalized in — and the run resolves to whichever
 * tag row it spells. An empty input keeps the old dispatch behavior: the dev row, run by hand.
 */
import { appendFileSync } from "node:fs";
import { PRERELEASE, SDK_SURFACE, STABLE, fail, git, requireOnMain } from "./release-channels.mjs";

function argOf(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * A dispatched run has no tag: `github.ref` is a branch. The `version` input lets a human name the
 * version that run releases. Only a dispatch may supply it — a tag push's ref is the tag and cannot be
 * overridden. The run pins the ancestor check to `GITHUB_SHA` (main's HEAD), so the input cannot point
 * a release away from main.
 */
function dispatchRef() {
  if ((argOf("event") ?? process.env.EVENT_NAME ?? "") !== "workflow_dispatch") return null;
  const version = (process.env.DISPATCH_VERSION ?? "").trim();
  if (!version) return null;
  return `refs/tags/${version.startsWith("v") ? version : `v${version}`}`;
}

/**
 * A dispatch may name the commit to release instead of taking the checked-out one, which is how a release is
 * cut at the commit an environment actually runs. It is still proved an ancestor of main.
 */
function dispatchCommit() {
  if ((argOf("event") ?? process.env.EVENT_NAME ?? "") !== "workflow_dispatch") return null;
  const commit = (process.env.DISPATCH_COMMIT ?? "").trim();
  if (!commit) return null;
  try {
    return git("rev-parse", "--verify", `${commit}^{commit}`);
  } catch {
    fail(`\`commit\` was set to ${commit}, which is not a commit in this repository`);
  }
}

const ref = argOf("ref") ?? dispatchRef() ?? process.env.GITHUB_REF ?? `refs/heads/${git("rev-parse", "--abbrev-ref", "HEAD")}`;
const sha = argOf("sha") ?? dispatchCommit() ?? process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
const short = sha.slice(0, 7);
let comparedAgainst = "";
let changeReason = "";

const NO_PARENT = /^0{40}$/;

/**
 * The range this push actually delivered, so a push carrying several commits cannot hide an SDK change behind
 * a later one that touches nothing. `github.event.before` is all-zeros on a force-push or a new branch, and
 * the first parent is the honest fallback.
 */
function pushedRange() {
  const before = (argOf("since") ?? process.env.PUSH_BEFORE ?? "").trim();
  for (const candidate of [before, `${sha}^`]) {
    if (!candidate || NO_PARENT.test(candidate)) continue;
    try {
      return `${git("rev-parse", "--verify", `${candidate}^{commit}`)}..${sha}`;
    } catch {
      // Try the fallback.
    }
  }
  return null;
}

/**
 * Whether this push touched anything the tarball is built from. A dispatched run never asks: that is the
 * escape hatch for republishing after a failed run, or for a change this list cannot see (the root
 * `tsconfig.base.json`, say).
 */
function sdkChanged() {
  if ((argOf("event") ?? process.env.EVENT_NAME ?? "") === "workflow_dispatch") {
    changeReason = "dispatched by hand, so the change gate is bypassed";
    return true;
  }

  const range = pushedRange();
  if (!range) {
    changeReason = "no previous commit to compare against, so nothing is assumed unchanged";
    return true;
  }

  const touched = git("diff", "--name-only", range, "--", ...SDK_SURFACE);
  if (!touched) {
    changeReason = `no change under ${SDK_SURFACE.join(", ")} in ${range.replace("..", " .. ")}`;
    return false;
  }
  const files = touched.split("\n").filter(Boolean);
  changeReason = `${files.length} file(s) changed under the SDK surface, including ${files[0]}`;
  return true;
}

/** Prereleases are excluded on purpose: an open `v0.1.2-rc.1` must not push dev builds to `0.1.3`. */
function highestStableTag() {
  let listed;
  try {
    listed = git("tag", "--list", "v*", "--sort=-v:refname");
  } catch {
    return null;
  }
  return listed.split("\n").find((tag) => STABLE.test(tag)) ?? null;
}

/**
 * `g` prefixes the sha because an all-digit identifier with a leading zero is invalid semver, and the
 * commit count leads it so two dev builds of the same target patch order monotonically.
 */
function devVersion() {
  const base = highestStableTag();
  const [, major, minor, patch] = base ? STABLE.exec(base) : [null, "0", "0", "0"];
  const next = `${major}.${minor}.${Number(patch) + 1}`;
  const count = base ? git("rev-list", "--count", `${base}..${sha}`) : git("rev-list", "--count", sha);
  return `${next}-dev.${count}.g${short}`;
}

/** The ancestor proof itself lives in `release-channels.mjs`; this records what it compared for the summary. */
function proveOnMain(tag) {
  comparedAgainst = requireOnMain({ sha, subject: tag, act: "release", main: argOf("main") });
}

function resolve() {
  if (ref === "refs/heads/main") {
    const changed = sdkChanged();
    return {
      channel: "dev",
      version: changed ? devVersion() : "",
      dist_tag: changed ? "dev" : "",
      publish_sdk: changed ? "true" : "false",
      publish_assets: "false",
    };
  }

  if (!ref.startsWith("refs/tags/")) {
    return { channel: "none", version: "", dist_tag: "", publish_sdk: "false", publish_assets: "false" };
  }

  const tag = ref.slice("refs/tags/".length);

  if (STABLE.test(tag)) {
    proveOnMain(tag);
    return { channel: "stable", version: tag.slice(1), dist_tag: "latest", publish_sdk: "true", publish_assets: "true" };
  }

  const pre = PRERELEASE.exec(tag);
  if (!pre) {
    fail(`${tag} is not a release tag: a release tag is \`vX.Y.Z\` or \`vX.Y.Z-<prerelease>\`, strict semver`);
  }
  if (/^dev(\.|$)/.test(pre[4])) {
    fail(`${tag} claims the \`dev\` prerelease, which only a main push may mint — tag \`-rc.N\` for the staging channel`);
  }
  proveOnMain(tag);
  return { channel: "staging", version: tag.slice(1), dist_tag: "staging", publish_sdk: "true", publish_assets: "true" };
}

const resolved = { ...resolve(), ref, sha };

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(resolved).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

console.log(`── ref        ${ref}`);
console.log(`── commit     ${short}`);
console.log(`── channel    ${resolved.channel}`);
console.log(
  resolved.publish_sdk === "true"
    ? `── publishes  soroban-verification-client@${resolved.version} under dist-tag \`${resolved.dist_tag}\``
    : `── publishes  nothing${resolved.channel === "dev" ? " — the SDK is unchanged" : ": this ref releases neither the SDK nor release assets"}`,
);
if (changeReason) console.log(`── sdk gate   ${changeReason}`);

// A run that published nothing should say so where a reader looks first, not only in this step's log.
if (process.env.GITHUB_STEP_SUMMARY && resolved.publish_sdk !== "true") {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### 🚫 no SDK publish — channel \`${resolved.channel}\`\n\n${changeReason || "this ref releases nothing"}\n\n`,
  );
}
if (comparedAgainst) console.log(`── on main    proved against ${comparedAgainst}`);
if (resolved.publish_assets === "true") console.log("── assets     the OpenAPI specifications are attached to the GitHub release");
