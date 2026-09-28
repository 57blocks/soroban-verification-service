#!/usr/bin/env node
/** Every `uses:` self-reference in `.github/` must be a sha whose copy of the path matches this tree; `--write` bumps stale pins. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SELF = "57blocks/soroban-verification-service";
const WRITE = process.argv.includes("--write");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const SELF_RE = SELF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REFERENCE = new RegExp(`^(\\s*(?:-\\s+)?uses:\\s*)${SELF_RE}/([^@\\s]+)@(\\S+?)(\\s*(?:#.*)?)$`);
const SHA = /^[0-9a-f]{40}$/;

/** `git diff <sha>` counts uncommitted edits but cannot see an untracked file, hence the separate ask. */
function matchesTree(sha, path) {
  if (git("ls-files", "--others", "--exclude-standard", "--", path)) return false;
  try {
    execFileSync("git", ["diff", "--quiet", sha, "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isCommit(sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** GitHub resolves `uses:@<sha>` only for a commit reachable from a branch or tag; a squash-merged head is not. */
function isReachable(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (git("rev-parse", "--is-shallow-repository") === "true") {
  console.error(
    "✗ this is a shallow clone, and the pinned commits are not in it. " +
      "The workflow that runs this check needs `fetch-depth: 0`.",
  );
  process.exit(1);
}

const files = git("ls-files", "--", ".github")
  .split("\n")
  .filter((f) => /\.ya?ml$/.test(f));

const findings = [];
let references = 0;
let rewritten = 0;

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let changed = false;

  lines.forEach((line, i) => {
    const match = REFERENCE.exec(line);
    if (!match) return;
    const [, prefix, path, ref, suffix] = match;
    references += 1;
    const at = `${file}:${i + 1}`;

    const current =
      SHA.test(ref) && isCommit(ref) && matchesTree(ref, path) && isReachable(ref);
    if (current) return;

    if (!WRITE) {
      if (!SHA.test(ref)) {
        findings.push(
          `${at}|${path} is referenced at '${ref}', a ref that moves. A caller pinning this workflow ` +
            `does not pin what this line resolves to — GitHub resolves it again when the job starts`,
        );
      } else if (!isCommit(ref)) {
        findings.push(`${at}|${ref} is not a commit in this repository, so this reference cannot resolve`);
      } else if (!isReachable(ref)) {
        findings.push(
          `${at}|${ref} is not an ancestor of HEAD, so GitHub cannot resolve this reference however ` +
            `identical its copy of ${path} is — every caller fails as a startup_failure with no job ` +
            `and no log. A squash-merged branch's head does this. Bump the pin: ` +
            `pnpm run check:workflow-pins -- --write`,
        );
      } else {
        findings.push(
          `${at}|${ref}'s copy of ${path} is not this tree's. Bump the pin: ` +
            `pnpm run check:workflow-pins -- --write`,
        );
      }
      return;
    }

    const target = git("log", "-1", "--format=%H", "--", path);
    if (!target) {
      findings.push(`${at}|${path} has no commit to pin to — commit it first`);
      return;
    }
    if (!matchesTree(target, path)) {
      findings.push(
        `${at}|${path} has changes that are not committed, so no commit carries this tree's copy of it. ` +
          `Commit those first; the pin is a follow-up commit`,
      );
      return;
    }
    lines[i] = `${prefix}${SELF}/${path}@${target}${suffix}`;
    changed = true;
    rewritten += 1;
  });

  if (changed) writeFileSync(file, lines.join("\n"));
}

if (findings.length > 0) {
  for (const finding of findings) {
    const [at, message] = finding.split("|");
    const [file, line] = at.split(":");
    console.error(`::error file=${file},line=${line}::${message}`);
    console.error(`  ✗ ${at} — ${message}`);
  }
  console.error(`\n✗ ${findings.length} self-reference(s) this tree does not pin`);
  process.exit(1);
}

if (WRITE) {
  console.log(
    rewritten === 0
      ? `✓ ${references} self-reference(s) already name a commit whose copy is this tree's`
      : `✓ bumped ${rewritten} of ${references} self-reference(s). Commit this, then run the check again — ` +
          `a file that just changed moves the pin of whatever references it`,
  );
} else {
  console.log(
    `✓ ${references} self-reference(s) in ${files.length} workflow file(s) name a commit whose copy of the ` +
      `referenced path is this tree's, so pinning a workflow here pins the pipeline below it`,
  );
}
