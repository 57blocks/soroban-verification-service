#!/usr/bin/env node
/**
 * Finds a live testnet contract the verifier **must permanently refuse**, so the refusal can be tested end to
 * end instead of only at the composition layer.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The real classifier and the real parser, from built output. */
let parseCliver;
let classifyBuildEnvironment;
try {
  const core = await import("../../../packages/core/dist/src/index.js");
  ({ parseCliver, classifyBuildEnvironment } = core);
} catch (error) {
  console.error(
    "cannot load @scvs/core's built output. This script judges contracts with the service's own\n" +
      "`parseCliver` and `classifyBuildEnvironment` rather than a copy of their rules, so it needs them\n" +
      "built:\n\n  pnpm --filter @scvs/core run build\n\n" +
      `underlying error: ${String(error?.message ?? error).split("\n")[0]}`,
  );
  process.exit(2);
}

const REFUSABLE_RSVERS = (process.env.SCVS_REFUSABLE_RSVERS ?? "1.81.0")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const NETWORK = process.env.SCVS_REFUSABLE_NETWORK ?? "testnet";
const INDEX = `https://api.stellar.expert/explorer/${NETWORK}/contract`;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

/**
 * Reads a deployed contract's metadata the way `deploy-testnet.sh` does — `stellar contract fetch` then
 * `stellar contract info meta`.
 */
async function readChainMetadata(contractId, workdir) {
  const wasmPath = join(workdir, `${contractId}.wasm`);
  await run("stellar", [
    "contract", "fetch", "--id", contractId, "--network", NETWORK, "--out-file", wasmPath,
  ]);
  const bytes = await readFile(wasmPath);
  const { stdout } = await run("stellar", [
    "contract", "info", "meta", "--wasm", wasmPath, "--output", "json",
  ]);

  /** @type {Record<string, string[]>} */
  const meta = {};
  for (const entry of JSON.parse(stdout)) {
    const kv = entry?.sc_meta_v0;
    if (!kv) continue;
    (meta[kv.key] ??= []).push(kv.val);
  }
  return { meta, wasmHash: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * A single value, or `undefined` for absent **and for repeated** — the same rule `build-purpose-contracts.sh`'s
 * `assert_metadata_value` uses.
 */
function single(meta, key) {
  const values = meta[key];
  return values?.length === 1 ? values[0] : undefined;
}

/**
 * Which permanent composition reason this contract would hit, or a `reject` explaining why it is not a
 * candidate.
 */
function verdictFor(meta) {
  const cliver = single(meta, "cliver");
  const rsver = single(meta, "rsver");

  if (meta.cliver?.length > 1 || meta.rsver?.length > 1) {
    return { reject: "records a repeated cliver/rsver — what it declares is ambiguous, so it cannot anchor an assertion" };
  }
  if (single(meta, "bldimg")) {
    return { reject: "records a bldimg → cli-58, resolved as `chain_named`; it never reaches composition at all" };
  }

  // `missing_toolchain_pair` and `undated_nightly` are refused at *preflight*, which is a different surface and
  // a different case — E2E-SUB-08 covers the synchronous family.
  const pair = cliver !== undefined && rsver !== undefined ? { cliver, rsver } : undefined;
  const classification = classifyBuildEnvironment({ pair });
  if (classification.kind !== "compose") {
    return {
      reject:
        `classification says ${classification.kind}` +
        (classification.reason ? ` / ${classification.reason}` : "") +
        " — refused before any composer job exists, so it tests the preflight path, not this one",
    };
  }

  // Routed to compose. Now: must the composer refuse it permanently?
  if (parseCliver(cliver) === undefined) {
    return {
      reason: "unaddressable_cliver",
      note: `cliver ${JSON.stringify(cliver)} is not a shape parseCliver understands, so components.ts ` +
        "refuses it before any download — while classification still said `compose`",
    };
  }
  if (REFUSABLE_RSVERS.includes(rsver)) {
    return {
      reason: "toolchain_target_unavailable",
      note: `rsver ${rsver} ships no wasm32v1-none, so the composer's pre-flight refuses it before any download`,
    };
  }

  return {
    reject:
      `cliver parses and rsver ${rsver} is servable (refusable set: ${REFUSABLE_RSVERS.join(", ")}) — ` +
      "this contract should verify, not be refused",
  };
}

async function check(contractIds) {
  const workdir = await mkdtemp(join(tmpdir(), "scvs-refusable-"));
  const found = [];
  const seenHashes = new Map();
  try {
    for (const contractId of contractIds) {
      let read;
      try {
        read = await readChainMetadata(contractId, workdir);
      } catch (error) {
        // Unreachable is not the same as unsuitable; reporting it as a rejection would quietly shrink the
        // candidate pool for an infrastructure reason.
        console.log(`?  ${contractId}  could not be read: ${String(error.message ?? error).split("\n")[0]}`);
        continue;
      }

      // Deduping on the hash makes the output the list of distinct *toolchains* seen, which is what is being
      // searched for.
      const already = seenHashes.get(read.wasmHash);
      if (already) {
        console.log(`=  ${contractId}  same Wasm as ${already} (${read.wasmHash.slice(0, 12)})`);
        continue;
      }
      seenHashes.set(read.wasmHash, contractId);

      const { meta, wasmHash } = read;
      const pair = `${single(meta, "cliver") ?? "(none)"} / ${single(meta, "rsver") ?? "(none)"}`;
      const verdict = verdictFor(meta);
      if (verdict.reject) {
        console.log(`✗  ${contractId}  ${pair}\n     ${verdict.reject}`);
        continue;
      }
      console.log(`✓  ${contractId}  ${pair}\n     ${verdict.reason} — ${verdict.note}`);
      found.push({ contractId, wasmHash, cliver: single(meta, "cliver"), rsver: single(meta, "rsver"), ...verdict });
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
  console.log(`\n${seenHashes.size} distinct Wasm across ${contractIds.length} contract id(s)`);
  return found;
}

/**
 * Enumerates contract ids from StellarExpert. Returns ids only — every judgement is made from chain bytes in
 * `check()`, never from the index.
 */
async function scan(pages) {
  const ids = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < pages; page += 1) {
    const url = new URL(INDEX);
    url.searchParams.set("limit", "200");
    url.searchParams.set("order", "desc");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      console.error(`scan stopped: ${url} → ${response.status}`);
      break;
    }
    const body = await response.json();
    for (const record of body?._embedded?.records ?? []) {
      if (typeof record?.contract === "string") ids.push(record.contract);
    }
    const next = new URL(body?._links?.next?.href ?? "", INDEX).searchParams.get("cursor");
    if (!next || seenCursors.has(next)) {
      console.error(
        `scan stopped after ${page + 1} page(s): the index cursor ${next ? "repeated" : "was absent"}.`,
      );
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }
  return [...new Set(ids)];
}

/** The registry entry, printed so it can be pasted rather than retyped. */
function printRegistryEntry(winner) {
  console.log(`  existing_testnet_refusable_${winner.reason === "unaddressable_cliver" ? "cliver" : "rsver"}:`);
  console.log(`    fixture_roles: [F-FLOOR-REFUSE]`);
  console.log(`    network: ${NETWORK}`);
  console.log(`    contract_id: ${winner.contractId}`);
  console.log(`    wasm_hash: ${winner.wasmHash}`);
  console.log(`    class: cli-legacy`);
  console.log(`    cliver: ${JSON.stringify(winner.cliver)}`);
  console.log(`    rsver: ${winner.rsver}`);
  console.log(`    expected_composition_reason: ${winner.reason}`);
  console.log(`    expected_verdict: policy_rejected`);
  console.log(`    status: ready`);
  console.log(`    validation:`);
  console.log(`      - fetched from ${NETWORK}; wasm_hash above is the sha256 of the fetched bytes`);
  console.log(`      - metadata parsed locally by \`stellar contract info meta\``);
  console.log(`      - classifyBuildEnvironment routes it to \`compose\`, so preflight cannot refuse it`);
  console.log(`      - ${winner.note}`);
  console.log(`      - ${winner.reason} is in PERMANENT_COMPOSITION_FAILURES, so the job must end policy_rejected`);
  console.log(`      - no rebuild evidence needed: the verdict is reached before any build`);
}

async function main() {
  const checkAt = process.argv.indexOf("--check");
  const explicit = checkAt === -1 ? [] : process.argv.slice(checkAt + 1).filter((a) => !a.startsWith("--"));

  console.log(`network         : ${NETWORK}`);
  console.log(`refusable rsvers: ${REFUSABLE_RSVERS.join(", ")}  (probe-corpus: nothing below 1.84.0 has wasm32v1-none)`);
  console.log(`also refusable  : any cliver @scvs/core's parseCliver() rejects → unaddressable_cliver\n`);

  let ids = explicit;
  if (process.argv.includes("--scan")) {
    const pages = Number(arg("pages", "5"));
    console.log(`scanning ${INDEX} for up to ${pages} page(s)…`);
    console.log(
      "★ this is a lexicographic walk from the top of the id space, not a sample of the corpus — see this\n" +
        "  file's header. Prefer --check with ids from the corpus scan's dataset.\n",
    );
    ids = [...new Set([...ids, ...(await scan(pages))])];
    console.log(`enumerated ${ids.length} contract id(s)\n`);
  }

  if (ids.length === 0) {
    console.error("nothing to check. Give ids with --check <id>… or enumerate with --scan.");
    process.exitCode = 2;
    return;
  }

  const found = await check(ids);

  console.log("");
  if (found.length === 0) {
    console.log("No refusable contract found among the ids checked.");
    console.log("That is not evidence none exists, and --scan is not a search — paging further descends the");
    console.log("id alphabet, it does not widen toolchain coverage. The corpus scan already enumerated all 99");
    console.log("live pairs; take ids from its dataset and pass them to --check.");
    process.exitCode = 1;
    return;
  }

  const byReason = new Map();
  for (const entry of found) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  console.log(
    `Found ${found.length}: ${[...byReason].map(([reason, count]) => `${count}× ${reason}`).join(", ")}\n`,
  );
  console.log("Register the first in test/fixtures/e2e/registry.yaml:\n");
  printRegistryEntry(found[0]);
  console.log(
    "\nThen set required_contracts.F-FLOOR-REFUSE to ready, move F-FLOOR-REFUSE out of\n" +
      "e2e-fixtures.dev.json's $omitted into contracts (source_uri/source_sha256 may be F-LEG-1's — the\n" +
      "archive is never opened), and E2E-SUB-09/unsupported_toolchain stops skipping.",
  );
}

await main();
