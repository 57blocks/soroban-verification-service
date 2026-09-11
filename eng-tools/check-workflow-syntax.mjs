#!/usr/bin/env node
/** Rejects a `.github/workflows/*.yml` that GitHub Actions would reject, before it is pushed. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";

/**
 * Duplicate-key detection by hand: a YAML library configured to reject them would be better, but the one
 * already in this repo's dependency tree does not offer it.
 */
function duplicateKeys(text) {
  const found = [];
  const stack = []; // { indent, keys: Set }
  let blockIndent = null; // inside a `|`/`>` scalar: the indent its content must exceed

  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || /^\s*#/.test(line)) return;
    const indent = line.length - line.trimStart().length;

    if (blockIndent !== null) {
      if (indent > blockIndent) return; // still inside the scalar
      blockIndent = null;
    }

    const m = /^(\s*)(-\s+)?([A-Za-z_][\w.-]*)\s*:(\s|$)/.exec(line);
    if (!m) return;
    // A list item starts a fresh mapping, so its keys cannot collide with the previous sibling's.
    const isListItem = Boolean(m[2]);
    const keyIndent = indent + (m[2]?.length ?? 0);
    const key = m[3];

    while (stack.length && stack[stack.length - 1].indent > keyIndent) stack.pop();
    if (isListItem) {
      while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    }
    let level = stack[stack.length - 1];
    if (!level || level.indent < keyIndent) {
      level = { indent: keyIndent, keys: new Set() };
      stack.push(level);
    }

    if (level.keys.has(key)) found.push({ line: i + 1, key });
    else level.keys.add(key);

    if (/:\s*[|>][-+]?\d*\s*$/.test(line)) blockIndent = keyIndent;
  });

  return found;
}

/** Every `run:` block's body, with GitHub expressions blanked so bash sees valid tokens. */
function runBlocks(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)run:\s*[|>][-+]?\d*\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.trim() && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    out.push({ line: i + 1, body: body.join("\n").replace(/\$\{\{[^}]*\}\}/g, "X") });
    i = j - 1;
  }
  return out;
}

/** Job-level `env:` entries that read the `env` context — which GitHub does not provide there. */
function jobLevelEnvContext(text) {
  const found = [];
  const lines = text.split("\n");
  let inJobs = false;
  let inJobEnv = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inJobs = /^jobs:\s*$/.test(line);
      inJobEnv = false;
      continue;
    }
    if (!inJobs) continue;
    // A new job, or any other key at job level, closes a previous job's env block.
    if (indent <= 2) {
      inJobEnv = false;
      continue;
    }
    if (indent === 4) {
      inJobEnv = /^\s*env:\s*$/.test(line);
      continue;
    }
    if (inJobEnv && indent === 6 && /\$\{\{[^}]*\benv\./.test(line)) {
      const key = (/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line) || [, line.trim()])[1];
      found.push({ line: i + 1, key });
    }
  }
  return found;
}

/** db-migrate.yml's preflight had no `actions/checkout` and was fixed by hand (#172). */
function repoScriptWithoutCheckout(text) {
  const found = [];
  const lines = text.split("\n");
  let inJobs = false;
  let jobName = null;
  let jobBlock = [];
  const finish = () => {
    if (!jobName) return;
    const block = jobBlock.join("\n");
    const calls = block
      .split("\n")
      .some((line) => /^\s*(?:[A-Za-z_]\w*=\$\(\s*)?bash scripts\/ci\/load-ci-descriptor\.sh\b/.test(line));
    const hasCheckout = /^\s*(?:-\s+)?uses:\s*actions\/checkout@/m.test(block);
    if (calls && !hasCheckout) found.push(jobName);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      finish();
      inJobs = /^jobs:\s*$/.test(line.trim());
      jobName = null;
      jobBlock = [];
      continue;
    }
    if (!inJobs) continue;
    if (indent === 2) {
      finish();
      jobName = /^([A-Za-z_][\w.-]*):/.exec(line.trim())?.[1] ?? null;
      jobBlock = [];
    } else if (jobName) {
      jobBlock.push(line);
    }
  }
  finish();
  return found;
}

let failures = 0;
for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const path = join(DIR, file);
  const text = readFileSync(path, "utf8");
  const problems = [];

  for (const { line, key } of duplicateKeys(text)) {
    problems.push(`${path}:${line} — '${key}' is already defined at this level. GitHub rejects the whole file`);
  }

  for (const { line, key } of jobLevelEnvContext(text)) {
    problems.push(
      `${path}:${line} — job-level env '${key}' reads the \`env\` context, which GitHub does not provide ` +
        `in jobs.<id>.env (step-level only). It rejects the whole file with "Unrecognized named-value: 'env'"`,
    );
  }

  for (const job of repoScriptWithoutCheckout(text)) {
    problems.push(
      `${path} — job '${job}' runs scripts/ci/load-ci-descriptor.sh without an actions/checkout step, ` +
        `so the script is not on disk and the step dies with exit 127`,
    );
  }

  for (const { line, body } of runBlocks(text)) {
    try {
      execFileSync("bash", ["-n"], { input: body, stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      problems.push(`${path}:${line} — shell syntax error in run block: ${String(error.stderr).trim()}`);
    }
  }

  if (problems.length) {
    failures += problems.length;
    for (const p of problems) console.error(`  ✗ ${p}`);
  }
}

if (failures) {
  console.error(`\n${failures} problem(s). GitHub validates workflows on push, so these fail the run itself.`);
  process.exit(1);
}
console.log(`✓ workflows parse with no duplicate keys, no job-level env reads the env context, every run block is valid shell, and every descriptor call happens in a checked-out job`);
