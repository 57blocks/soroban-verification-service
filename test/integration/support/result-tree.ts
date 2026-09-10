/** Reading the published result tree from the static origin. */
import { linkUrls, type RegistryResultUrl } from "./types.js";
import { expectStatus, http, sha256Hex, type HttpResult } from "./http.js";
import {
  staticPolicyUrl,
  staticReportUrl,
  staticVerifierManifestUrl,
  staticWasmStatusUrl,
} from "./routes.js";
import type {
  RegistryStatusObject,
  VerificationArtifact,
  VerifierManifest,
  VerifierPolicy,
} from "./types.js";

/**
 * `wasms/{hash}.json`. S3-backed static origins may spell a missing private bucket key as 403 instead of 404;
 * either means no readable status object.
 */
export async function readStatusObject(
  wasmHash: string
): Promise<{ found: false; result: HttpResult } | { found: true; object: RegistryStatusObject; result: HttpResult }> {
  const result = await http(staticWasmStatusUrl(wasmHash));
  if (result.status === 403 || result.status === 404) return { found: false, result };
  expectStatus(result, 200);
  return { found: true, object: result.json as RegistryStatusObject, result };
}

export async function requireStatusObject(wasmHash: string): Promise<RegistryStatusObject> {
  const read = await readStatusObject(wasmHash);
  if (!read.found) {
    throw new Error(
      `No published status object at ${staticWasmStatusUrl(wasmHash)} (${read.result.status}).`
    );
  }
  return read.object;
}

/** The report artifact, fetched by URL rather than by hash. */
export async function readReportByUrl(
  url: string
): Promise<{ artifact: VerificationArtifact; bytes: Uint8Array; sha256: string; result: HttpResult }> {
  const result = await http(url);
  expectStatus(result, 200);
  return {
    artifact: result.json as VerificationArtifact,
    bytes: result.bytes,
    sha256: sha256Hex(result.bytes),
    result,
  };
}

export async function readReportByHash(reportSha256: string) {
  return readReportByUrl(staticReportUrl(reportSha256));
}

export async function readPolicy(): Promise<VerifierPolicy> {
  const result = await http(staticPolicyUrl());
  expectStatus(result, 200);
  return result.json as VerifierPolicy;
}

export async function readVerifierManifest(): Promise<VerifierManifest> {
  const result = await http(staticVerifierManifestUrl());
  expectStatus(result, 200);
  return result.json as VerifierManifest;
}

/** Resolves the report for a finished job. */
export async function reportForJob(
  jobResult: { artifact_url?: string } | undefined,
  wasmHash?: string
): Promise<{ artifact: VerificationArtifact; bytes: Uint8Array; sha256: string } | undefined> {
  if (jobResult?.artifact_url) return readReportByUrl(jobResult.artifact_url);
  if (!wasmHash) return undefined;

  const read = await readStatusObject(wasmHash);
  if (!read.found) return undefined;

  for (const entry of read.object.source_code_verifications) {
    const pointer = linkUrls(entry).find((url) => url.includes("/reports/"));
    if (pointer) return readReportByUrl(pointer);
  }
  return undefined;
}

/** This verifier as a published document identifies it: `url` is the result root, `name` is self-claimed. */
export interface OwnVerifierIdentity {
  readonly url: string;
  readonly name?: string;
}

/**
 * `SCVS_E2E_VERIFIER_URL` short-circuits the manifest read: it exists for a deployment whose manifest
 * the runner cannot reach, and `readVerifierManifest` throws on anything but a `200`.
 */
export async function ownVerifierIdentity(): Promise<OwnVerifierIdentity> {
  const url = process.env.SCVS_E2E_VERIFIER_URL;
  const name = process.env.SCVS_E2E_VERIFIER_NAME;
  if (url) return name ? { url, name } : { url };
  const manifest = await readVerifierManifest();
  return { url: manifest.url, name: name ?? manifest.display_name };
}

/**
 * Comparable form of a result root: scheme and host lowercased, one trailing slash dropped, path case
 * preserved. Mirrors `normalizeVerifierUrl` in `packages/core` (dry-run findings §1.4).
 */
export function normalizeResultRoot(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

type OwnEntryCandidate = {
  verifier?: { url?: string; name?: string };
  results_urls?: RegistryResultUrl[];
};

/**
 * Picks this verifier's own entry, by result root rather than by display name. Three rules
 * in order, mirroring `packages/storage-layout`'s `findOwnEntry`.
 */
export function ownEntryOf<T extends OwnEntryCandidate>(
  entries: readonly T[],
  identity: OwnVerifierIdentity
): T | undefined {
  return (
    entries.find((entry) => declaresOurRoot(entry, identity)) ??
    entries.find((entry) => linksUnderOurRoot(entry, identity)) ??
    entries.find((entry) => carriesOurLegacyName(entry, identity))
  );
}

/** The same three rules as a predicate, for a case counting or filtering rather than picking one. */
export function isOwnEntry(entry: OwnEntryCandidate, identity: OwnVerifierIdentity): boolean {
  return (
    declaresOurRoot(entry, identity) ||
    linksUnderOurRoot(entry, identity) ||
    carriesOurLegacyName(entry, identity)
  );
}

/** 1. The identity itself, and the only rule that establishes ownership rather than confirming it. */
function declaresOurRoot(entry: OwnEntryCandidate, identity: OwnVerifierIdentity): boolean {
  return entry.verifier?.url !== undefined && normalizeResultRoot(entry.verifier.url) === normalizeResultRoot(identity.url);
}

/**
 * 2. A document published before the cutover carries no `url` at all — the draft shape had no field
 *    for it. An entry whose links sit under our own root is ours whatever it calls itself, which is
 *    also why renaming the operator cannot orphan a published hash.
 */
function linksUnderOurRoot(entry: OwnEntryCandidate, identity: OwnVerifierIdentity): boolean {
  if (entry.verifier?.url !== undefined) return false;
  const prefix = `${normalizeResultRoot(identity.url)}/`;
  return linkUrls(entry).some((url) => normalizeResultRoot(url).startsWith(prefix));
}

/**
 * 3. Last resort: a legacy entry that declares no identity *and* links nothing under our root — an
 *    `unverified` one has neither. `name` is self-claimed, so this can only ever confirm a guess,
 *    and it is skipped entirely when we hold no name: two `undefined`s are not a match.
 */
function carriesOurLegacyName(entry: OwnEntryCandidate, identity: OwnVerifierIdentity): boolean {
  if (identity.name === undefined) return false;
  return entry.verifier?.url === undefined && entry.verifier?.name === identity.name;
}

/** Fails loudly when a hash already carries a `verified` entry from us. */
export async function assertHashNotYetVerifiedByUs(
  wasmHash: string,
  caseId: string
): Promise<void> {
  const existing = await readStatusObject(wasmHash);
  if (!existing.found) return;

  const identity = await ownVerifierIdentity();
  const ours = ownEntryOf(existing.object.source_code_verifications, identity);
  if (ours?.status !== "verified") return;

  throw new Error(
    `${caseId} precondition violated: ${wasmHash} already carries a \`verified\` entry from ` +
      `${identity.url}. ADR-014 forbids a \`mismatched\` from displacing it, so ` +
      `this case's published assertion can never hold against this hash again.\n\n` +
      `Fix the fixture, not the case: the mismatch fixture needs its own deployed target contract, ` +
      `separate from the one the verified fixture uses. ` +
      `test/fixtures/e2e/deploy-testnet.sh deploys one with a deterministic salt.`
  );
}
