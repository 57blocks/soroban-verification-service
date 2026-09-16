#!/usr/bin/env tsx
/**
 * Seeds the `trusted_verifiers` table from a `stellar-trusted-verifiers-list-v1` document via
 * `@scvs/db-query`'s `upsertTrustedVerifier`.
 */
// Loads the workspace root .env: this script runs from the repository root via `pnpm run db:seed-tvl`, so it
// never picked up a `.env` and failed on a missing POSTGRES_DB regardless of configuration.
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

/** Both spellings are accepted. */
const ACCEPTED_SCHEMAS = [TRUSTED_VERIFIERS_LIST_SCHEMA, TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY];
const DEFAULT_SOURCE = "config/trusted-verifiers.local.json";

// A TVL entry's URLs become query-svc's outbound fetch origins (`originsFromVerifiers`) the moment this
// script seeds them — same standard `SCVS_TRUSTED_VERIFIERS_SOURCE` above already holds itself to, applied
// to what the source actually contains instead of just where it came from. Private-range/localhost hosts are
// allowed only for the built-in `DEFAULT_SOURCE` fixture, never for anything `SCVS_TRUSTED_VERIFIERS_SOURCE`
// names explicitly: a *file path* is not a trust signal on its own — a real deployment's own configuration is
// free to point this variable at a checked-in file too, and that file seeds a real, network-reachable
// environment. Only the fixture this script falls back to when nothing was configured at all is actually
// local-developer-only.
const ENTRY_URL_POLICY = normalizePolicy({ allowedSchemes: ["https:"] });
const ENTRY_URL_POLICY_LOCAL = normalizePolicy({ allowedSchemes: ["https:", "http:"], blockPrivateRanges: false });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Returns the document text, a label for it, and whether it's the built-in local-dev fixture. */
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
    // An https: source is fetched over the network, so — unlike a file path, which is already
    // reviewable repository content — nothing here proves the response is what was intended.
    // SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256 pins the exact content expected, the same way this
    // repository pins a GitHub Actions `uses:` to a commit SHA rather than trusting a mutable ref.
    const expectedDigest = process.env.SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256?.trim();
    if (!expectedDigest) {
      throw new Error(
        `SCVS_TRUSTED_VERIFIERS_SOURCE is an https: URL (${url}) but SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256 ` +
          `is not set. An https: source must declare the sha256 (hex) of the exact content it is expected ` +
          `to return — without it, a compromised host or a poisoned cache could substitute different ` +
          `content and this script would seed it without detecting anything wrong.`,
      );
    }
    // Caught here, before any network request, so a malformed pin (a typo, a base64 digest pasted
    // where hex was expected, wrong length) is reported as its own distinct, diagnosable problem —
    // not as a confusing "expected <garbage>, got <realhex>" digest mismatch further down, which
    // would leave an operator unsure whether the PIN or the CONTENT is what's actually wrong.
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
    // Hashed over the exact bytes on the wire, before any text decoding — a pin must cover what was
    // actually transmitted, not a re-encoded or re-parsed form of it.
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

  // Relative to the repository root rather than `process.cwd()`: this runs both from a workspace checkout
  // (`pnpm run db:seed-tvl`, cwd = root) and from `/app` inside the service image, and a cwd-relative path
  // silently resolves differently between the two.
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
    for (const [field, value] of [
      ["url", verifier.url],
      ["manifest_url", verifier.manifest_url],
      ["bulk_load_url", verifier.bulk_load_url],
    ] as const) {
      if (value === undefined) continue; // only `url` is actually optional — the check above already guarantees the other two
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
