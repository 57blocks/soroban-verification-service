#!/usr/bin/env node
/** Proves the dist-tag this run wrote resolves to the version it published, and `latest` holds no prerelease. */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function argOf(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const ATTEMPTS = argOf("attempts", 12);
const WAIT_MS = argOf("wait-ms", 5000);

const inGha = Boolean(process.env.GITHUB_ACTIONS);
const pkg = "soroban-verification-client";
const version = process.env.SDK_VERSION?.trim();
const distTag = process.env.DIST_TAG?.trim();

function fail(reason) {
  console.log(inGha ? `::error::${reason}` : `  ✗ ${reason}`);
  process.exit(1);
}

if (!version || !distTag) fail("SDK_VERSION and DIST_TAG must both be set — resolve-release-channel.mjs sets them");

/** A throwaway cache: `npm publish --dry-run` leaves the pre-publish packument in npm's own cache. */
const cache = mkdtempSync(join(tmpdir(), "scvs-disttags-"));

function distTags() {
  const out = execFileSync("npm", ["view", pkg, "dist-tags", "--json", "--prefer-online", "--cache", cache], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{}, ${ms})`]);

let tags = {};
let landed = false;
try {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      tags = distTags();
    } catch (error) {
      tags = {};
      if (attempt === ATTEMPTS) {
        fail(`could not read ${pkg}'s dist-tags: ${`${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-3).join(" / ")}`);
      }
    }
    if (tags[distTag] === version) {
      landed = true;
      if (attempt > 1) console.log(`── ${distTag} resolved on attempt ${attempt} of ${ATTEMPTS}`);
      break;
    }
    if (attempt < ATTEMPTS) sleep(WAIT_MS);
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}

if (!landed) {
  fail(
    `dist-tag \`${distTag}\` resolves to ${tags[distTag] ?? "nothing"}, not the ${version} this run published, ` +
      `after ${(ATTEMPTS * WAIT_MS) / 1000}s — the version exists but no consumer asking for \`${distTag}\` would get it`,
  );
}

if (tags.latest && /-/.test(tags.latest)) {
  fail(`dist-tag \`latest\` points at ${tags.latest}, a prerelease — \`npm install ${pkg}\` would hand a consumer a prerelease`);
}

console.log(`── dist-tags  ${JSON.stringify(tags)}`);
console.log(`✓ \`${distTag}\` = ${version}, and \`latest\` = ${tags.latest ?? "nothing"} is not a prerelease`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const sha = (process.env.SDK_COMMIT || process.env.GITHUB_SHA || "").slice(0, 7);
  const rows = [
    ["version", `\`${version}\``],
    ["channel", process.env.CHANNEL ?? "unknown"],
    ["dist-tag", `\`${distTag}\``],
    ["commit", sha ? `\`${sha}\`` : "unrecorded"],
    ["registry", process.env.SCVS_SDK_REGISTRY?.trim() || "the public npm registry"],
  ];
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### 📦 published \`${pkg}@${version}\``,
      "",
      "| | |",
      "| --- | --- |",
      ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "```bash",
      `npm install ${pkg}@${distTag}      # newest on this channel`,
      `npm install ${pkg}@${version}      # exactly this build`,
      "```",
      "",
      `Every dist-tag now: ${Object.entries(tags).map(([t, v]) => `\`${t}\` → ${v}`).join(", ")}`,
      "",
    ].join("\n"),
  );
}
