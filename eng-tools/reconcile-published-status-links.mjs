#!/usr/bin/env node
/** Diffs what the job rows say this verifier published against `wasms/{hash}.json`; `--apply` marks missing links pending. */
import { readFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";

const APPLY = argv.includes("--apply");
const JSON_OUT = argv.includes("--json");

function requireEnv(name) {
  const value = env[name];
  if (!value) {
    console.error(`${name} is required. This tool reads one live environment; see eng-tools/README.md's \`ops:\` row.`);
    exit(2);
  }
  return value;
}

async function readDocument(root, wasmHash) {
  const url = `${root.replace(/\/+$/, "")}/wasms/${wasmHash}.json`;
  if (url.startsWith("file://") || url.startsWith("/")) {
    try {
      return { document: JSON.parse(await readFile(url.replace(/^file:\/\//, ""), "utf8")) };
    } catch (error) {
      return { unreadable: error.code === "ENOENT" ? "absent" : "unparseable" };
    }
  }
  const response = await fetch(url);
  if (response.status === 404) return { unreadable: "absent" };
  if (!response.ok) return { unreadable: `http_${response.status}` };
  try {
    return { document: JSON.parse(await response.text()) };
  } catch {
    return { unreadable: "unparseable" };
  }
}

function ownEntry(document, publicRoot) {
  const root = `${publicRoot.replace(/\/+$/, "")}/`;
  return (document?.source_code_verifications ?? []).find(
    (entry) =>
      entry.verifier?.url === publicRoot.replace(/\/+$/, "") ||
      (entry.results_urls ?? []).some((link) => (typeof link === "string" ? link : link.url)?.startsWith(root)),
  );
}

function linkUrls(entry) {
  const results = (entry?.results_urls ?? []).map((link) => (typeof link === "string" ? link : link.url));
  const sources = (entry?.verified_source_code_uris ?? []).map((uri) => (typeof uri === "string" ? uri : uri.url));
  return new Set([...results, ...sources, entry?.source_uri].filter(Boolean));
}

async function main() {
  const { PrismaClient } = await import("../packages/db/dist/generated/prisma/client.js").catch(() => ({}));
  if (!PrismaClient) {
    console.error("Build @scvs/db first: pnpm --filter @scvs/db run build");
    exit(2);
  }
  const publicRoot = requireEnv("SCVS_PUBLIC_RESULT_ROOT").replace(/\/+$/, "");
  const gateway = (env.SCVS_ARWEAVE_GATEWAY_URL || "https://gateway.irys.xyz").replace(/\/+$/, "");
  const prisma = new PrismaClient();

  const jobs = await prisma.job.findMany({
    where: { publishedUpdatedAt: { not: null } },
    select: {
      id: true, result: true, archivedTxId: true, sourceArchivedTxId: true, sourceFileName: true,
      verdict: true, statusLinkPendingSince: true, statusLinkBlockedReason: true,
    },
  });

  const missingLinks = [];
  const verdictInconsistent = [];
  const unreadable = [];

  for (const job of jobs) {
    const wasmHash = job.result?.wasm_hash;
    if (!wasmHash) continue;
    const read = await readDocument(publicRoot, wasmHash);
    if (read.unreadable) {
      unreadable.push({ jobId: job.id, wasmHash, why: read.unreadable });
      continue;
    }
    const entry = ownEntry(read.document, publicRoot);
    if (!entry) {
      unreadable.push({ jobId: job.id, wasmHash, why: "no entry of ours" });
      continue;
    }

    const present = linkUrls(entry);
    const owed = [];
    if (job.archivedTxId && !present.has(`${gateway}/${job.archivedTxId}`)) owed.push("report archive");
    if (job.sourceArchivedTxId && !present.has(`${gateway}/${job.sourceArchivedTxId}`)) owed.push("source archive");
    if (job.sourceFileName && !present.has(`${publicRoot}/sources/${job.sourceFileName}`)) owed.push("source uri");
    if (owed.length > 0 && !job.statusLinkPendingSince) {
      missingLinks.push({ jobId: job.id, wasmHash, owed });
    }

    if (job.verdict && entry.status && job.verdict !== entry.status) {
      verdictInconsistent.push({ jobId: job.id, wasmHash, row: job.verdict, published: entry.status });
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ missingLinks, verdictInconsistent, unreadable, applied: APPLY }, null, 2));
  } else {
    console.log(`${jobs.length} published job(s) checked against ${publicRoot}`);
    console.log(`  missing_links        ${missingLinks.length}`);
    console.log(`  verdict_inconsistent ${verdictInconsistent.length}   (reported only — never rewritten here)`);
    console.log(`  unreadable           ${unreadable.length}`);
    for (const row of verdictInconsistent) {
      console.log(`    ! ${row.jobId} ${row.wasmHash}: row says ${row.row}, published says ${row.published}`);
    }
  }

  if (APPLY && missingLinks.length > 0) {
    const now = new Date();
    await prisma.job.updateMany({
      where: { id: { in: missingLinks.map((row) => row.jobId) }, statusLinkPendingSince: null },
      data: { statusLinkPendingSince: now },
    });
    console.log(`marked ${missingLinks.length} job(s) pending; the recovery scan will replay their links`);
  } else if (missingLinks.length > 0) {
    console.log("re-run with --apply to mark these pending");
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
