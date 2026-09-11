#!/usr/bin/env node
/**
 * The only writer of a real `soroban-verification-client` version: the tag is the version, so the committed manifest holds a
 * placeholder and CI stamps the resolved one in. It also records the commit, which is what lets the publish
 * step tell an idempotent re-run apart from a version being quietly reused for different source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const manifestPath = join(resolve(import.meta.dirname, ".."), "clients/sdk/package.json");

function required(name) {
  const value = process.env[name]?.trim();
  if (value) return value;
  console.log(`::error::${name} is unset, so there is no version to stamp — resolve-release-channel.mjs runs first`);
  process.exit(1);
}

const version = required("SDK_VERSION");
const channel = required("CHANNEL");
// The commit being released, which a dispatch may point away from the one the run started on.
const sha = process.env.SDK_COMMIT?.trim() || required("GITHUB_SHA");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
manifest.scvs = { channel, gitSha: sha, ref: process.env.GITHUB_REF ?? "" };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`── stamped soroban-verification-client@${version} · channel ${channel} · ${sha.slice(0, 7)}`);
