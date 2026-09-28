#!/usr/bin/env tsx
/** Seeds the `trusted_verifiers` table from a `stellar-trusted-verifiers-list-v1` document. */
// Loads the workspace root .env, which a run from the repository root would otherwise miss.
import "@scvs/config/load-env";
import { createHash } from "node:crypto";
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
import { checkUrl, normalizePolicy, FetchPolicyError } from "@scvs/core/fetch-policy";

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

const ACCEPTED_SCHEMAS = [TRUSTED_VERIFIERS_LIST_SCHEMA, TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY];
const DEFAULT_SOURCE = "config/trusted-verifiers.local.json";

// Private-range/localhost entry URLs are allowed only for the built-in `DEFAULT_SOURCE` fixture.
const ENTRY_URL_POLICY = normalizePolicy({ allowedSchemes: ["https:"] });
const ENTRY_URL_POLICY_LOCAL = normalizePolicy({ allowedSchemes: ["https:", "http:"], blockPrivateRanges: false });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadSource(): Promise<{ label: string; raw: string; isDefaultFixture: boolean }> {
  const configured = process.env.SCVS_TRUSTED_VERIFIERS_SOURCE?.trim();
  const source = configured || DEFAULT_SOURCE;
  const isDefaultFixture = !configured;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.protocol !== "https:") {
      throw new Error(
        `SCVS_TRUSTED_VERIFIERS_SOURCE must be an https: URL or a file path; got "${url.protocol}//". ` +
          `The TVL decides which verifiers are trusted — fetching it over a rewritable channel puts ` +
          `that decision on the network. Use a local path for development.`,
      );
    }
    const expectedDigest = process.env.SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256?.trim();
    if (!expectedDigest) {
      throw new Error(
        `SCVS_TRUSTED_VERIFIERS_SOURCE is an https: URL (${url}) but SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256 ` +
          `is not set. An https: source must declare the sha256 (hex) of the exact content it is expected ` +
          `to return — without it, a compromised host or a poisoned cache could substitute different ` +
          `content and this script would seed it without detecting anything wrong.`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(expectedDigest)) {
      throw new Error(
        `SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256 is not a valid sha256 hex digest (expected 64 hex ` +
          `characters, got "${expectedDigest}"). Check for a typo or a digest in the wrong format ` +
          `(e.g. base64 instead of hex).`,
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
    // Hash the exact bytes on the wire, before any text decoding.
    const bytes = await response.arrayBuffer();
    const actualDigest = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if (actualDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
      throw new Error(
        `Trusted verifiers list fetched from ${url} does not match the pinned content: ` +
          `expected sha256 ${expectedDigest}, got ${actualDigest}. This means the source's content no ` +
          `longer matches SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256 — either the document was legitimately ` +
          `updated and the pin needs to change, or the response was tampered with. Refusing to seed ` +
          `either way; verify the content before updating the pin.`,
      );
    }
    return { label: url.toString(), raw: new TextDecoder().decode(bytes), isDefaultFixture };
  }

  // Relative to the repository root, not cwd: this also runs from `/app` in the service image.
  const path = isAbsolute(source) ? source : resolve(repoRoot, source);
  const raw = await readFile(path, "utf8").catch((error: Error) => {
    throw new Error(`Could not read trusted verifiers config at ${path}: ${error.message}`);
  });
  return { label: path, raw, isDefaultFixture };
}

async function main(): Promise<void> {
  const { label, raw, isDefaultFixture } = await loadSource();
  console.log(`[seed-tvl] Source: ${label}`);
  const entryUrlPolicy = isDefaultFixture ? ENTRY_URL_POLICY_LOCAL : ENTRY_URL_POLICY;

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
    if (
      verifier.status !== undefined &&
      !trustedVerifierStatuses.includes(verifier.status as (typeof trustedVerifierStatuses)[number])
    ) {
      throw new Error(
        `Verifier "${verifier.id}" in ${label} has status "${verifier.status}", which is not one of ` +
          `${trustedVerifierStatuses.join(" | ")}.`,
      );
    }
    for (const [field, value] of [
      ["url", verifier.url],
      ["manifest_url", verifier.manifest_url],
      ["bulk_load_url", verifier.bulk_load_url],
    ] as const) {
      if (value === undefined) continue;
      try {
        checkUrl(entryUrlPolicy, value);
      } catch (error) {
        throw new Error(
          `Verifier "${verifier.id}" in ${label}: ${field} "${value}" is not an admissible URL — ` +
            `${error instanceof FetchPolicyError ? error.message : String(error)}`,
        );
      }
    }
  }

  const verifiersRepository = new TrustedVerifiersRepository(
    createPrismaClient(readDbEnv()),
  );

  for (const verifier of doc.verifiers) {
    const manifestUrl = verifier.manifest_url;
    // Through `resultRootOf`: deriving the root from `manifest_url` would seed the manifest directory.
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
