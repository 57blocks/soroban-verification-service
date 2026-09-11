#!/usr/bin/env tsx
/**
 * Seeds the `trusted_verifiers` table from a `stellar-trusted-verifiers-list-v1` document via
 * `@scvs/db-query`'s `upsertTrustedVerifier`.
 */
// Loads the workspace root .env: this script runs from the repository root via `pnpm run db:seed-tvl`, so it
// never picked up a `.env` and failed on a missing POSTGRES_DB regardless of configuration.
import "@scvs/config/load-env";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { readDbEnv } from "@scvs/db";
import {
  createPrismaClient,
  TrustedVerifiersRepository,
} from "@scvs/db-query";
import {
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY,
  trustedVerifierStatuses,
  resultRootOf,
} from "@scvs/storage-layout/shapes";

type TrustedVerifiersListDocument = {
  schema: string;
  schema_version?: string;
  verifiers: Array<{
    id: string;
    display_name?: string;
    url?: string;
    manifest_url: string;
    bulk_load_url?: string;
    trust_tier?: string;
    status?: string;
  }>;
  updated_at?: string;
};

/** Both spellings are accepted. */
const ACCEPTED_SCHEMAS = [TRUSTED_VERIFIERS_LIST_SCHEMA, TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY];
const DEFAULT_SOURCE = "config/trusted-verifiers.local.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Returns the document text and a label for it. */
async function loadSource(): Promise<{ label: string; raw: string }> {
  const configured = process.env.SCVS_TRUSTED_VERIFIERS_SOURCE?.trim();
  const source = configured || DEFAULT_SOURCE;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.protocol !== "https:") {
      throw new Error(
        `SCVS_TRUSTED_VERIFIERS_SOURCE must be an https: URL or a file path; got "${url.protocol}//". ` +
          `The TVL decides which verifiers are trusted — fetching it over a rewritable channel puts ` +
          `that decision on the network. Use a local path for development.`,
      );
    }
    const response = await fetch(url).catch((error: Error) => {
      throw new Error(`Could not fetch trusted verifiers list from ${url}: ${error.message}`);
    });
    if (!response.ok) {
      throw new Error(
        `Could not fetch trusted verifiers list from ${url}: HTTP ${response.status} ${response.statusText}`,
      );
    }
    return { label: url.toString(), raw: await response.text() };
  }

  // Relative to the repository root rather than `process.cwd()`: this runs both from a workspace checkout
  // (`pnpm run db:seed-tvl`, cwd = root) and from `/app` inside the service image, and a cwd-relative path
  // silently resolves differently between the two.
  const path = isAbsolute(source) ? source : resolve(repoRoot, source);
  const raw = await readFile(path, "utf8").catch((error: Error) => {
    throw new Error(`Could not read trusted verifiers config at ${path}: ${error.message}`);
  });
  return { label: path, raw };
}

async function main(): Promise<void> {
  const { label, raw } = await loadSource();
  console.log(`[seed-tvl] Source: ${label}`);

  const doc = JSON.parse(raw) as TrustedVerifiersListDocument;
  if (!ACCEPTED_SCHEMAS.includes(doc.schema as (typeof ACCEPTED_SCHEMAS)[number])) {
    throw new Error(
      `Unexpected schema "${doc.schema}" in ${label}; expected one of ${ACCEPTED_SCHEMAS.join(" | ")}.`,
    );
  }

  if (!Array.isArray(doc.verifiers) || doc.verifiers.length === 0) {
    throw new Error(
      `No verifiers in ${label}. An empty list seeds an empty table, and the symptom surfaces later ` +
        `as GET /verifiers returning [] — see this file's header.`,
    );
  }

  for (const verifier of doc.verifiers) {
    if (!verifier?.id || !verifier?.manifest_url || !verifier?.bulk_load_url) {
      throw new Error(
        `Malformed verifier entry in ${label} (needs \`id\`, \`manifest_url\`, and \`bulk_load_url\` — ` +
          `there is no supported static-only member): ${JSON.stringify(verifier)}`,
      );
    }
    // Checked here rather than left to the column, which is a plain String and would take it.
    if (
      verifier.status !== undefined &&
      !trustedVerifierStatuses.includes(verifier.status as (typeof trustedVerifierStatuses)[number])
    ) {
      throw new Error(
        `Verifier "${verifier.id}" in ${label} has status "${verifier.status}", which is not one of ` +
          `${trustedVerifierStatuses.join(" | ")}.`,
      );
    }
  }

  // `@scvs/db-query` hands its repositories out through NestJS DI now; this script has no container, so it
  // builds the same class over its own client.
  const verifiersRepository = new TrustedVerifiersRepository(
    createPrismaClient(readDbEnv()),
  );

  for (const verifier of doc.verifiers) {
    const manifestUrl = verifier.manifest_url;
    // Through `resultRootOf`, so a `-v1` document's `cdn_root` is read rather than silently missed: deriving
    // the root from `manifest_url` instead would seed a peer's *manifest* directory as its result root, and
    // every status read under it would 404.
    const resultsRoot = resultRootOf(verifier);
    if (resultsRoot === undefined) {
      throw new Error(`verifier ${verifier.id}: no result root (neither "url" nor "cdn_root")`);
    }

    const record = await verifiersRepository.upsertTrustedVerifier({
      verifierId: verifier.id,
      manifestUrl,
      resultsRoot,
      displayName: verifier.display_name,
      trustTier: verifier.trust_tier,
      bulkLoadUrl: verifier.bulk_load_url,
      ...(verifier.status !== undefined ? { status: verifier.status } : {}),
    });
    console.log(
      `[seed-tvl] Upserted ${record.verifierId} (display_name=${record.displayName ?? "—"}, ` +
        `status=${record.status}, resultsRoot=${record.resultsRoot})`,
    );
  }

  console.log(`[seed-tvl] ${doc.verifiers.length} verifier(s) from ${label}.`);
}

main()
  .then(() => {
    console.log("[seed-tvl] Done.");
  })
  .catch((error) => {
    console.error("[seed-tvl] Failed:", error);
    process.exitCode = 1;
  });
