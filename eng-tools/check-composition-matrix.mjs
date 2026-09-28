#!/usr/bin/env node
/** Runs the composition gate across every recorded `(cliver, rsver)` pair and reports each outcome. */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSITION_PAIRS,
  CORPUS_STABLE_RSVERS,
  NAMED_COMPOSITION_FAILURES,
  assertChainFormClivers,
} from "./composition-pairs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GATE = join(ROOT, "eng-tools/check-composition-template.mjs");
const TEMPLATE_ROOT = join(ROOT, "docker/composed-environments");

const RUSTUP_CHANNEL = "https://static.rust-lang.org/dist";
const RESULT_SCHEMA = "scvs-composition-matrix-result-v1";

function has(flag) {
  return process.argv.includes(`--${flag}`);
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

async function main() {
  assertChainFormClivers();

  const { CURRENT_COMPOSE_TEMPLATE_VERSION } = await import("../packages/core/dist/src/index.js");
  const templateVersion = arg("template-version", CURRENT_COMPOSE_TEMPLATE_VERSION);
  const template = JSON.parse(
    await readFile(join(TEMPLATE_ROOT, templateVersion, "template.json"), "utf8"),
  );

  const only = arg("only");
  const outputPath = arg("output");
  const rows = only ? COMPOSITION_PAIRS.filter((pair) => pair.id === only) : COMPOSITION_PAIRS;
  if (rows.length === 0) {
    console.error(`No composition pair matches --only ${JSON.stringify(only)}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`template_version : ${templateVersion}`);
  console.log(`platform         : ${template.platform}`);
  console.log(`rust targets     : ${(template.rust?.targets ?? []).join(", ") || "(none declared)"}`);
  console.log(`rows             : ${rows.length} of ${COMPOSITION_PAIRS.length}`);

  const probes = await probeRustTargets(rows, template);
  if (has("probe-only")) {
    printProbeLedger(probes);
    const exitCode = probes.some((probe) => probe.outcome === "error" || probe.outcome === "unparseable")
      ? 1
      : 0;
    await writeResult(outputPath, matrixResult({
      templateVersion,
      template,
      only,
      rows,
      probes,
      results: [],
      exitCode,
    }));
    process.exitCode = exitCode;
    return;
  }

  const results = [];
  for (const row of rows) {
    console.log(`\n${"═".repeat(96)}\n▶ ${row.id}  —  ${row.cliver} / ${row.rsver}  [${row.expect}]`);
    console.log(`  ${row.why}\n`);

    let result = await composeOne(row, templateVersion);
    if (result.outcome === "inconclusive") {
      console.log(`\n  ↻ ${row.id}: ${result.message ?? "infrastructure failure"} — retrying once\n`);
      result = await composeOne(row, templateVersion);
    }
    results.push(result);
  }

  printProbeLedger(probes);
  printLedger(results);
  const exitCode = exitCodeFor(results);
  await writeResult(outputPath, matrixResult({
    templateVersion,
    template,
    only,
    rows,
    probes,
    results,
    exitCode,
  }));
  process.exitCode = exitCode;
}

function matrixResult({ templateVersion, template, only, rows, probes, results, exitCode }) {
  return {
    schema: RESULT_SCHEMA,
    generated_at: new Date().toISOString(),
    node_version: process.version,
    template: {
      version: templateVersion,
      platform: template.platform,
      rust_targets: template.rust?.targets ?? [],
    },
    selection: {
      only: only ?? null,
      row_count: rows.length,
      total_row_count: COMPOSITION_PAIRS.length,
    },
    probes,
    results,
    exit_code: exitCode,
  };
}

async function writeResult(outputPath, result) {
  if (!outputPath) return;
  const absolutePath = resolve(ROOT, outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`result_json      : ${absolutePath}`);
}

async function probeRustTargets(rows, template) {
  const targets = template.rust?.targets ?? [];
  const versions = [
    ...new Set([...rows.map((row) => row.rsver), ...(has("probe-corpus") ? CORPUS_STABLE_RSVERS : [])]),
  ].sort(compareRsver);
  const probes = [];

  const record = (rsver, outcome, detail) => {
    probes.push({ rsver, outcome, detail });
    console.log(`  ${rsver.padEnd(16)} ${outcome.padEnd(16)} ${detail}`);
  };

  console.log(`\n— probing rustup channel manifests for ${targets.join(", ") || "(no targets)"} —`);
  for (const rsver of versions) {
    if (/nightly|beta/.test(rsver)) {
      record(rsver, "skipped", "no dated channel manifest for an undated marker");
      continue;
    }

    const url = `${RUSTUP_CHANNEL}/channel-rust-${rsver}.toml`;
    try {
      const response = await fetch(url, { headers: { "user-agent": "scvs-composition-matrix" } });
      if (response.status === 404) {
        record(rsver, "no-manifest", `${url} → 404`);
      } else if (!response.ok) {
        record(rsver, "error", `${url} → ${response.status}`);
      } else {
        const manifest = await response.text();
        if (!manifest.includes("[pkg.rust-std.target.")) {
          record(rsver, "unparseable", "no `[pkg.rust-std.target.…]` section — the reader's assumption is stale");
        } else {
          const missing = targets.filter((target) => !declaresAvailableTarget(manifest, target));
          record(
            rsver,
            missing.length === 0 ? "has-targets" : "missing-targets",
            missing.length === 0 ? targets.join(", ") : `missing ${missing.join(", ")}`,
          );
        }
      }
    } catch (error) {
      record(rsver, "error", error?.message ?? String(error));
    }
  }
  return probes;
}

function declaresAvailableTarget(manifest, target) {
  const header = `[pkg.rust-std.target.${target}]`;
  const at = manifest.indexOf(header);
  if (at === -1) return false;
  const nextSection = manifest.indexOf("\n[", at + header.length);
  const section = manifest.slice(at, nextSection === -1 ? undefined : nextSection);
  return /available\s*=\s*true/.test(section);
}

function isInfrastructureFailure(reason, message, output = "") {
  const text = String(message ?? "");
  if (reason === "component_unreachable") {
    // Transient only: "publishes no … asset" shares this reason and is permanent.
    return /returned \d{3}\b/.test(text) || /exceeded \d+ms/.test(text) || /downloaded as zero bytes/.test(text);
  }
  if (reason === "image_build_failed") {
    const haystack = `${text}\n${output}`;
    return /failed to build: EOF/.test(haystack) || /Cannot connect to the Docker daemon/.test(haystack);
  }
  return false;
}

async function composeOne(row, templateVersion) {
  const args = [
    GATE,
    "--template-version",
    templateVersion,
    "--cliver",
    row.cliver,
    "--rsver",
    row.rsver,
  ];
  if (has("no-contract-build")) args.push("--no-contract-build");

  const { code, output } = await run(process.execPath, args);
  if (code === 0) return { ...row, outcome: "composed" };

  const marked = /✗ Template .* failed \[([a-z_]+)\]: ([^\n]*)/.exec(output);
  if (marked) {
    const [, reason, message] = marked;
    if (isInfrastructureFailure(reason, message, output)) {
      return { ...row, outcome: "inconclusive", reason, message: message.trim() };
    }
    return {
      ...row,
      outcome: NAMED_COMPOSITION_FAILURES.includes(reason) ? "named-failure" : "unnamed-reason",
      reason,
      message: message.trim(),
    };
  }
  if (isInfrastructureFailure("image_build_failed", "", output)) {
    return { ...row, outcome: "inconclusive", message: "docker reported a transport failure" };
  }

  const unmarked = /✗ Template .* failed: ([^\n]*)/.exec(output);
  return {
    ...row,
    outcome: "unnamed-failure",
    message: (unmarked?.[1] ?? `the gate exited ${code} without a failure line`).trim(),
  };
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("error", (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

function compareRsver(a, b) {
  const parts = (v) => v.split("-")[0].split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return a.localeCompare(b);
}

function printProbeLedger(probes) {
  if (probes.length === 0) return;
  console.log(`\n${"─".repeat(96)}\nrustup target availability`);
  for (const probe of probes) {
    console.log(`  ${probe.rsver.padEnd(16)} ${probe.outcome.padEnd(16)} ${probe.detail}`);
  }

  const missing = probes.filter((probe) => probe.outcome === "missing-targets").map((p) => p.rsver);
  const present = probes.filter((probe) => probe.outcome === "has-targets").map((p) => p.rsver);
  if (missing.length > 0 && present.length > 0) {
    const highestMissing = [...missing].sort(compareRsver).at(-1);
    const lowestPresent = [...present].sort(compareRsver)[0];
    console.log(
      `\n  → boundary: highest rsver WITHOUT the template's target is ${highestMissing}; ` +
        `lowest WITH it is ${lowestPresent}.`,
    );
    console.log(
      "    A recorded rsver at or below the first cannot be composed by any template pinning this " +
        "target. Today it reaches `image_build_failed`, which is reported to the submitter as " +
        "retryable — see the ★★ note in `packages/core/src/composer.ts`.",
    );
  } else if (missing.length === 0 && present.length > 0) {
    console.log("\n  → every probed rsver distributes the template's target.");
  }
}

function printLedger(results) {
  console.log(`\n${"─".repeat(96)}\ncomposition matrix`);
  for (const result of results) {
    const detail = result.reason ? `${result.reason} — ${result.message ?? ""}` : (result.message ?? "");
    console.log(
      `  ${result.id.padEnd(34)} ${result.expect.padEnd(9)} ${result.outcome.padEnd(16)} ${detail}`.trimEnd(),
    );
  }

  const inconclusive = results.filter((result) => result.outcome === "inconclusive");
  if (inconclusive.length > 0) {
    console.log(
      `\n  ⚠ ${inconclusive.length} row(s) measured nothing — infrastructure, not a property of the pair:`,
    );
    for (const row of inconclusive) {
      console.log(`      ${row.id}: ${row.reason ?? "—"} — ${row.message ?? ""}`.trimEnd());
    }
    console.log("      Re-run these; they are not results and must not be read as any.");
  }

  const decided = new Set(["composed", "named-failure"]);
  const dimensions = new Set(results.flatMap((result) => result.dimensions));
  const unexercised = [...dimensions].filter((dimension) =>
    results.every((result) => !result.dimensions.includes(dimension) || !decided.has(result.outcome)),
  );
  if (unexercised.length > 0) {
    console.log(`\n  ⚠ no row reached a decided outcome for: ${unexercised.join(", ")}`);
  }
}

function exitCodeFor(results) {
  const strict = has("strict");
  const failures = results.filter((result) => {
    if (result.outcome === "composed") return false;
    if (result.outcome === "inconclusive") return false;
    if (result.outcome === "unnamed-failure" || result.outcome === "unnamed-reason") return true;
    return strict || result.expect === "composes";
  });

  const unmeasured = results.filter((result) => result.outcome === "inconclusive");
  if (failures.length === 0) {
    if (unmeasured.length === results.length) {
      console.error(`\n✗ no row produced a result — all ${results.length} were infrastructure failures.`);
      return 1;
    }
    if (unmeasured.length > 0) {
      console.log(
        `\n✓ ${results.length - unmeasured.length} row(s) produced a result: composed, or failed for a ` +
          `reason the composer already names.\n` +
          `  ${unmeasured.length} row(s) measured nothing and are still open — see the ⚠ above.`,
      );
      return 0;
    }
    console.log("\n✓ every row either composed or failed for a reason the composer already names.");
    return 0;
  }
  console.error(`\n✗ ${failures.length} row(s) failed: ${failures.map((f) => f.id).join(", ")}`);
  return 1;
}

await main();
