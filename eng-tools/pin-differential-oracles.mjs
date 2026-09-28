#!/usr/bin/env node
/** Resolves the differential oracles against the registry and checks each image is what the table says. */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORACLES_TS = new URL("../services/builder/test/differential/oracles.ts", import.meta.url);

const DIGEST = /@sha256:[0-9a-f]{64}$/;

function has(flag) {
  return process.argv.includes(`--${flag}`);
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function readOracles() {
  const source = await readFile(ORACLES_TS, "utf8");

  const consts = new Map();
  for (const m of source.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*\n?\s*"([^"]+)"/g)) {
    consts.set(m[1], m[2]);
  }

  const oracles = [];
  const block = /\{\s*id:\s*"([^"]+)",\s*cliver:\s*"([^"]+)",\s*rsver:\s*"([^"]+)",\s*tag:\s*"([^"]+)",([\s\S]*?)\n  \}/g;
  for (const match of source.matchAll(block)) {
    const [, id, cliver, rsver, tag, tail] = match;
    const env = /env:\s*"([^"]+)"/.exec(tail)?.[1];
    const literal = /image:\s*"([^"]+)"/.exec(tail)?.[1];
    const named = /image:\s*([A-Z][A-Z0-9_]*)/.exec(tail)?.[1];
    const image = literal ?? (named ? consts.get(named) : undefined);
    const elsewhere = /tagResolvesElsewhere:\s*"([^"]+)"/.exec(tail)?.[1];
    oracles.push({ id, cliver, rsver, tag, env, image, elsewhere, named });
  }
  if (oracles.length === 0) {
    throw new Error(
      `Parsed no oracles out of ${ORACLES_TS.pathname}. The table's shape changed — fix this reader ` +
        "rather than letting it report an empty, green run.",
    );
  }
  for (const oracle of oracles) {
    if (oracle.named && !oracle.image) {
      throw new Error(
        `${oracle.id} names the constant ${oracle.named} for its image and this reader could not find ` +
          "it. Refusing to report the row as unpinned, which is what silently re-exporting it would do.",
      );
    }
  }
  return oracles;
}

function classify(message) {
  const text = String(message ?? "");
  if (/\b(not found|manifest unknown|repository does not exist|no such manifest)\b/i.test(text)) {
    return "gone";
  }
  if (
    /\b(5\d{2}|forbidden|unauthorized|timeout|timed out|toomanyrequests|rate limit|EOF|connection reset|i\/o timeout|TLS handshake|proxy)\b/i.test(
      text,
    )
  ) {
    return "unreachable";
  }
  return "gone";
}

async function resolveDigest(tag) {
  const read = (stdout) => {
    const trimmed = stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(trimmed)) return trimmed;
    // Older buildx ignores `--format` and prints the human block, so parse that too.
    return /^Digest:\s*(sha256:[0-9a-f]{64})/m.exec(stdout)?.[1];
  };

  try {
    const { stdout } = await run("docker", [
      "buildx",
      "imagetools",
      "inspect",
      tag,
      "--format",
      "{{.Manifest.Digest}}",
    ]);
    const digest = read(stdout);
    if (digest) return { ok: true, digest };
  } catch (error) {
    const message = error?.stderr || error?.message || String(error);
    const kind = classify(message);
    if (kind === "gone") return { ok: false, kind, message: firstLine(message) };
  }

  try {
    const { stdout } = await run("docker", ["buildx", "imagetools", "inspect", tag]);
    const digest = read(stdout);
    if (digest) return { ok: true, digest };
    return { ok: false, kind: "gone", message: "no Digest line in `imagetools inspect` output" };
  } catch (error) {
    const message = error?.stderr || error?.message || String(error);
    return { ok: false, kind: classify(message), message: firstLine(message) };
  }
}

function firstLine(text) {
  return String(text).split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? String(text);
}

async function declaredRustVersion(reference) {
  await run("docker", ["pull", "--quiet", reference], { maxBuffer: 8 * 1024 * 1024 });
  const { stdout } = await run("docker", [
    "inspect",
    "--format",
    "{{range .Config.Env}}{{println .}}{{end}}",
    reference,
  ]);
  return /^RUST_VERSION=(.+)$/m.exec(stdout)?.[1]?.trim();
}

function repositoryOf(tag) {
  return tag.split(":")[0];
}

async function check(oracles) {
  const rows = [];
  for (const oracle of oracles) {
    process.stdout.write(`\n▶ ${oracle.id}  (${oracle.tag})\n`);
    if (!oracle.image) {
      console.log("  – no committed digest — nothing to check (run without --check to pin it)");
      rows.push({ oracle, state: "unpinned" });
      continue;
    }

    const resolved = await resolveDigest(oracle.tag);
    if (!resolved.ok) {
      const state = resolved.kind === "gone" ? "gone" : "unreachable";
      console.log(`  ${state === "gone" ? "✗" : "↻"} ${state}: ${resolved.message}`);
      rows.push({ oracle, state, message: resolved.message });
      continue;
    }

    const committed = oracle.image.split("@")[1];
    const expected = oracle.elsewhere ?? committed;
    if (resolved.digest === expected) {
      const note = oracle.elsewhere ? " (declared divergence, unchanged)" : "";
      console.log(`  ✓ tag still resolves to ${resolved.digest}${note}`);
      rows.push({ oracle, state: "match" });
      continue;
    }

    console.log(`  ✗ drift: tag resolves to ${resolved.digest}`);
    console.log(`           table ${oracle.elsewhere ? "declares tagResolvesElsewhere" : "commits"} ${expected}`);
    rows.push({ oracle, state: "drift", found: resolved.digest, expected });
  }

  console.log(`\n${"─".repeat(96)}`);
  for (const row of rows) console.log(`  ${row.state.padEnd(11)} ${row.oracle.id}`);

  const findings = rows.filter((row) => row.state === "drift" || row.state === "gone");
  const inconclusive = rows.filter((row) => row.state === "unreachable");
  if (inconclusive.length > 0) {
    console.log(
      `\n↻ ${inconclusive.length} row(s) unreachable — measured nothing, not a finding. Re-run when the ` +
        "registry answers.",
    );
  }
  if (findings.length === 0) {
    const matched = rows.filter((row) => row.state === "match").length;
    if (matched === 0) {
      console.log(
        `◌ nothing was measured: ${inconclusive.length} unreachable, ` +
          `${rows.filter((row) => row.state === "unpinned").length} unpinned. This is not a pass.`,
      );
    } else if (inconclusive.length > 0) {
      console.log(`✓ ${matched} matched, ${inconclusive.length} unreachable — not a full pass.`);
    } else {
      console.log(`✓ every committed oracle still matches the registry (${matched} checked).`);
    }
    if (inconclusive.length > 0 && has("strict")) process.exitCode = 1;
    return;
  }
  console.error(`\n✗ ${findings.length} finding(s):`);
  for (const row of findings) {
    console.error(
      row.state === "gone"
        ? `   · ${row.oracle.id}: ${row.oracle.tag} is gone — ${row.message}`
        : `   · ${row.oracle.id}: tag moved to ${row.found}, table has ${row.expected}`,
    );
  }
  console.error(
    "\nA moved tag is not automatically a reason to re-pin: it changes which toolchain the differential " +
      "claim is about. Decide, then commit.",
  );
  process.exitCode = 1;
}

async function pin(oracles) {
  const wanted = oracles.filter((oracle) => (has("all") ? true : !oracle.image));

  console.log(`oracle table : ${oracles.length} entries, ${wanted.length} to resolve`);
  if (wanted.length === 0) {
    console.log("Nothing to do — every oracle already carries a committed digest. Use --check to");
    console.log("re-check them against the registry, or --all to re-resolve and re-verify every row.");
    return;
  }

  const exports = [];
  const failures = [];

  for (const oracle of wanted) {
    process.stdout.write(`\n▶ ${oracle.id}  (${oracle.tag})\n`);

    let reference;
    if (oracle.image) {
      reference = oracle.image;
      console.log(`  digest : ${reference.split("@")[1]}  (committed)`);
    } else {
      const resolved = await resolveDigest(oracle.tag);
      if (!resolved.ok) {
        failures.push({ oracle, kind: resolved.kind, message: resolved.message });
        console.log(`  ${resolved.kind === "gone" ? "✗" : "↻"} ${resolved.kind}: ${resolved.message}`);
        continue;
      }
      console.log(`  digest : ${resolved.digest}`);
      reference = `${repositoryOf(oracle.tag)}@${resolved.digest}`;
      if (!DIGEST.test(reference)) {
        failures.push({ oracle, kind: "gone", message: `assembled ${reference} is not digest-pinned` });
        console.log(`  ✗ assembled a reference that is not digest-pinned: ${reference}`);
        continue;
      }
    }

    if (!has("no-verify")) {
      try {
        const declared = await declaredRustVersion(reference);
        if (declared === undefined) {
          console.log(`  rust   : (image declares no RUST_VERSION — unverified, table says ${oracle.rsver})`);
        } else if (declared !== oracle.rsver) {
          failures.push({
            oracle,
            kind: "disagrees",
            message: `image declares RUST_VERSION=${declared} but the table claims ${oracle.rsver}`,
          });
          console.log(`  ✗ rust : image says ${declared}, table says ${oracle.rsver} — refusing to pin`);
          console.log("    The tag has moved since corpus scan §7. Update oracles.ts, then re-run.");
          continue;
        } else {
          console.log(`  rust   : ${declared} ✓ matches the table`);
        }
      } catch (error) {
        const message = firstLine(error?.stderr || error?.message || String(error));
        failures.push({ oracle, kind: classify(message), message: `could not verify — ${message}` });
        console.log(`  ✗ could not verify: ${message}`);
        continue;
      }
    }

    if (oracle.image) {
      console.log("  ✓ committed digest re-verified; nothing to export");
      continue;
    }
    if (!oracle.env) {
      failures.push({
        oracle,
        kind: "disagrees",
        message: "row has neither a committed image nor an env to supply one through",
      });
      console.log("  ✗ no `env` in the table and no committed `image` — cannot emit an export for it");
      continue;
    }
    exports.push(`export ${oracle.env}=${reference}`);
  }

  if (exports.length > 0) {
    const body = `${exports.join("\n")}\n`;
    console.log(`\n${"─".repeat(96)}\n${body}`);
    console.log("Prefer committing these as `image` literals in oracles.ts over exporting them; the");
    console.log("argument is in that file's header. Exports are for a one-off experiment.");
    const target = arg("write");
    if (target) {
      await writeFile(new URL(target, `file://${ROOT}`), body, "utf8");
      console.log(`written to ${target}`);
    }
  }

  const real = failures.filter((f) => f.kind !== "unreachable");
  const flaky = failures.filter((f) => f.kind === "unreachable");
  if (flaky.length > 0) {
    console.log(`\n↻ ${flaky.length} row(s) unreachable — measured nothing:`);
    for (const f of flaky) console.log(`   · ${f.oracle.id}: ${f.message}`);
  }
  if (real.length > 0) {
    console.error(`\n✗ ${real.length} oracle(s) not pinned:`);
    for (const f of real) console.error(`   · [${f.kind}] ${f.oracle.id}: ${f.message}`);
    process.exitCode = 1;
  } else if (flaky.length > 0) {
    process.exitCode = has("strict") ? 1 : 0;
  } else {
    console.log("✓ every requested oracle resolved and verified.");
  }
}

async function main() {
  const oracles = await readOracles();
  if (has("check")) return await check(oracles);
  return await pin(oracles);
}

await main();
