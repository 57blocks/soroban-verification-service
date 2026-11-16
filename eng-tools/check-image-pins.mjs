#!/usr/bin/env node
/** Static, no network. Every external `FROM` in a tracked Dockerfile names its image by tag and sha256 digest; a `FROM ${ARG}` with no default is pinned by whoever builds it. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files", "*Dockerfile", "*.Dockerfile"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const PINNED = /^[^\s@:]+(?:\/[^\s@:]+)*:[^\s@]+@sha256:[0-9a-f]{64}$/;
const problems = [];

for (const file of files) {
  const stages = new Set();
  const callerArgs = new Set();
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const arg = line.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (arg) callerArgs.add(arg[1]);
      const match = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i);
      if (!match) return;
      const [, image, alias] = match;
      const fromArg = image.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
      if (!stages.has(image) && image !== "scratch" && !callerArgs.has(fromArg) && !PINNED.test(image)) {
        problems.push(`${file}:${index + 1}: ${image} is not pinned as name:tag@sha256:<digest>`);
      }
      if (alias) stages.add(alias);
    });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`check:image-pins: every FROM in ${files.length} Dockerfile(s) is pinned by digest.`);
