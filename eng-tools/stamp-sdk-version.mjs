#!/usr/bin/env node
/** Stamps the resolved version and commit into `clients/sdk/package.json`; the committed manifest holds a placeholder. */
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
// SDK_COMMIT first: a dispatch may release a commit other than the one the run started on.
const sha = process.env.SDK_COMMIT?.trim() || required("GITHUB_SHA");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
manifest.scvs = { channel, gitSha: sha, ref: process.env.GITHUB_REF ?? "" };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`── stamped soroban-verification-client@${version} · channel ${channel} · ${sha.slice(0, 7)}`);
