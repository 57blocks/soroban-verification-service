#!/usr/bin/env node
/**
 * Holds every reference this repository's workflows make to THIS repository at a commit whose copy of the
 * referenced path is the one in this tree.
 *
 * `uses:` cannot be an expression, so a workflow that is itself called cannot name the ref it was called at:
 * a nested `uses:` resolves on its own, at run time, against whatever the ref means then. An outer pin
 * therefore reaches the workflow it names and nothing below it. That is not theoretical — a caller pinning
 * `deploy.yml` to a sha has already run a `db-migrate.yml` two commits newer, in the same run. What the pin
 * could not reach was the pipeline's two most credential-adjacent files: `db-migrate.yml`, which assumes the
 * deploy role, and `actions/source-token`, which receives the App private key. GitHub's
 * `referenced_workflows` reports workflows only, so the action references escaped an audit of the run too.
 *
 * A commit cannot contain its own sha, so a pin names the commit that last changed the referenced path and a
 * follow-up commit bumps it. Content is what makes that sound, not identity: this refuses a pin whose copy of
 * the path differs by a byte from the working tree's, so a pinned outer workflow is a pinned pipeline.
 * Bumping converges in as many commits as the reference graph is deep — `deploy.yml` → `db-migrate.yml` →
 * `actions/source-token`, so two.
 *
 *   pnpm run check:workflow-pins              # every self-reference is a sha, and that sha is this tree
 *   pnpm run check:workflow-pins -- --write   # bump the stale ones, then commit the result
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** The one literal a fork edits, and the same one the workflows themselves carry as `source_repository`. */
const SELF = "57blocks/soroban-verification-service";
const WRITE = process.argv.includes("--write");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const SELF_RE = SELF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REFERENCE = new RegExp(`^(\\s*(?:-\\s+)?uses:\\s*)${SELF_RE}/([^@\\s]+)@(\\S+?)(\\s*(?:#.*)?)$`);
const SHA = /^[0-9a-f]{40}$/;

/**
 * True when `sha`'s copy of `path` is byte-for-byte the working tree's. `git diff` compares the tree, so an
 * uncommitted edit counts — which is the point, since the pin has to match what is about to be committed.
 * It cannot see an untracked file, so that is asked separately.
 */
function matchesTree(sha, path) {
  if (git("ls-files", "--others", "--exclude-standard", "--", path)) return false;
  try {
    execFileSync("git", ["diff", "--quiet", sha, "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false; // exit 1 is "they differ"; anything higher is a sha this caller already checked
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

// A shallow clone has neither the pinned commits nor the history to place them, and answering "current"
// from what it does have would be the wrong answer rather than no answer.
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

    const current = SHA.test(ref) && isCommit(ref) && matchesTree(ref, path);
    if (current) return;

    if (!WRITE) {
      if (!SHA.test(ref)) {
        findings.push(
          `${at}|${path} is referenced at '${ref}', a ref that moves. A caller pinning this workflow ` +
            `does not pin what this line resolves to — GitHub resolves it again when the job starts`,
        );
      } else if (!isCommit(ref)) {
        findings.push(`${at}|${ref} is not a commit in this repository, so this reference cannot resolve`);
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
