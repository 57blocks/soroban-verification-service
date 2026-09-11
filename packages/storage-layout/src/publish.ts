import { createHash } from "node:crypto";
import {
  legacySingularSourceUri,
  parseDto,
  toResultUrl,
  toSourceCodeUri,
  upgradeLegacyEntry,
  type LegacyCustody,
  type PeerRegistryStatusObject,
  type RegistrySourceCodeUri,
} from "@scvs/core";
import { VerificationArtifact, VerifierManifest, VerifierPolicy } from "./shapes.js";
import { reportKey, sourceKey, verifierManifestKey, verifierPolicyKey, wasmStatusKey } from "./keys.js";
import { readWasmStatus } from "./read.js";
import { rewriteWasmStatus } from "./registry-status.js";
import type { ResultStorage } from "./storage-backend.js";

/**
 * The ONE canonical byte serialization of a report artifact — pretty-printed, trailing newline, same as every
 * other document this package writes.
 */
export function serializeReport(artifact: VerificationArtifact): { bytes: string; sha256: string } {
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

/**
 * Writes reports/{sha256}.json — sha256 computed by serializeReport over the exact bytes written, never a field
 * on the artifact itself (RA1).
 */
export async function publishReport(
  storage: ResultStorage,
  artifact: VerificationArtifact,
): Promise<{ sha256: string; bytes: string }> {
  const { bytes, sha256 } = serializeReport(artifact);
  await storage.writeText(reportKey(sha256), bytes, "application/json; charset=utf-8");
  return { sha256, bytes };
}

export type PublishSourceParams = {
  sourceSha256: string;
  bytes: Uint8Array; // the tarball bytes, read once from staging before job termination
  /** The extension this was published under — e.g. ".tar.gz", ".zip". */
  extension: string;
  /**
   * Best-effort MIME type for the published object — not load-bearing (nothing in this codebase re-derives
   * behavior from it), included only because `writeBytes` requires one.
   */
  contentType: string;
};

/**
 * Idempotent by construction: re-publishing the same sha256+extension overwrites identical bytes at the same
 * content-addressed key, so a retry after a partial failure needs no pre-check.
 */
export async function publishSource(storage: ResultStorage, params: PublishSourceParams): Promise<void> {
  await storage.writeBytes(sourceKey(params.sourceSha256, params.extension), params.bytes, params.contentType);
}

/** The source modes this verifier actually accepts, which is what its `policy.json` may claim. */
export const SERVED_SOURCE_MODES = ["private_uploaded_tarball", "source_uri"] as const;

export type WriteVerifierPolicyParams = {
  policyId: string;
  acceptedTrustLevels: string[];
  digestPinnedOnly: boolean;
  tagOnlyAllowed: boolean;
  arbitraryUserImagesAllowed: boolean;
  requiresTarballSha256Match: boolean;
  resultArtifactsRetained: boolean;
};

/** Same defect, third instance: nothing consults the value — `submit.service.ts` does not read it. */
export async function writeVerifierPolicy(
  storage: ResultStorage,
  params: WriteVerifierPolicyParams,
): Promise<VerifierPolicy> {
  const policy = parseDto(VerifierPolicy, {
    schema: "stellar-verifier-policy-v1",
    id: params.policyId,
    build_images: {
      accepted_trust_levels: params.acceptedTrustLevels,
      digest_pinned_only: params.digestPinnedOnly,
      tag_only_allowed: params.tagOnlyAllowed,
      arbitrary_user_images_allowed: params.arbitraryUserImagesAllowed,
    },
    source_modes: [...SERVED_SOURCE_MODES],
    private_source: {
      requires_tarball_sha256_match: params.requiresTarballSha256Match,
      publish_source_bytes: true,
    },
    retention: {
      source_retained_after_verification: true,
      result_artifacts_retained: params.resultArtifactsRetained,
    },
  } satisfies VerifierPolicy);
  await writeJson(storage, verifierPolicyKey(), policy);
  return policy;
}

export type WriteVerifierManifestParams = {
  id: string;
  displayName: string;
  resultRootUrl: string;
};

/**
 * Writes verifier-manifest.json — this verifier's self-description, generated from live configuration and this
 * file's key conventions.
 */
export async function writeVerifierManifest(
  storage: ResultStorage,
  params: WriteVerifierManifestParams,
): Promise<VerifierManifest> {
  const now = new Date().toISOString();
  const manifest = parseDto(VerifierManifest, {
    schema: "stellar-verifier-manifest-v1",
    id: params.id,
    display_name: params.displayName,
    url: params.resultRootUrl,
    policy_url: `${params.resultRootUrl}/${verifierPolicyKey()}`,
    updated_at: now,
  } satisfies VerifierManifest);
  await writeJson(storage, verifierManifestKey(), manifest);
  return manifest;
}

export type AppendArchiveReferenceParams = {
  /** The HTTPS report URL this verification published — the key that finds our entry. */
  reportUrl: string;
  /** The report's own sha256: the archive copy is the same bytes (AP1), so it anchors that link too (AU1). */
  reportSha256: string;
  /** Directly fetchable (a gateway URL), never a bare `ar://` URI — nothing here resolves one for a consumer. */
  archiveUrl: string;
  /** What a legacy (draft-shape) entry of ours cannot carry itself, read from the report artifact. */
  legacyCustody?: LegacyCustody;
};

/**
 * Adds the archive copy to `reportUrl`'s own entry in `wasms/{wasmHash}.json` as a `results_urls` entry `{type:
 * "report", location: "arweave", url, sha256}` (AP5/AP6, AU1). **Appends**.
 */
export async function appendArchiveReference(
  storage: ResultStorage,
  wasmHash: string,
  params: AppendArchiveReferenceParams,
): Promise<boolean> {
  return withWasmStatusLock(wasmHash, async () => {
    const existing = await readWasmStatus(storage, wasmHash);
    if (!existing) return false;

    const index = entryIndexByReport(existing, params.reportUrl);
    if (index < 0) return false; // a newer verification already replaced this entry

    const entry = existing.source_code_verifications[index];
    const links = (entry.results_urls ?? []).map(toResultUrl);
    if (links.some((link) => link.url === params.archiveUrl)) return false; // already linked

    // The entry was located by *our own* report URL, so custody is about this entry and no other: the trust
    // level read from that report, and the result root we published under, which the draft shape had no field
    // for.
    const upgraded = upgradeLegacyEntry(entry, { ...params.legacyCustody, verifierUrl: storage.publicRoot });
    if (!upgraded) return false;
    // `upgraded.results_urls`, not `links`: the upgrade is what narrows a peer's open link vocabulary to the
    // producer's closed one, and the replacement is a producer entry. `links` above is only a dedupe read.
    const replacement = {
      ...upgraded,
      results_urls: [
        ...(upgraded.results_urls ?? []),
        { type: "report" as const, location: "arweave" as const, url: params.archiveUrl, sha256: params.reportSha256 },
      ],
    };
    const updated = rewriteWasmStatus(existing, index, replacement, new Date().toISOString());
    if (!updated) return false;
    await writeJson(storage, wasmStatusKey(wasmHash), updated);
    return true;
  });
}

export type AppendVerifiedSourceCodeUriParams = {
  reportUrl: string;
  sourceCodeUri: RegistrySourceCodeUri;
  legacyCustody?: LegacyCustody;
};

/**
 * Same anchoring (`reportUrl`), same upgrade-on-write and `updated_at` behaviour, same "never touch a
 * verdict-bearing field" rule as `appendArchiveReference`.
 */
export async function appendVerifiedSourceCodeUri(
  storage: ResultStorage,
  wasmHash: string,
  params: AppendVerifiedSourceCodeUriParams,
): Promise<boolean> {
  return withWasmStatusLock(wasmHash, async () => {
    const existing = await readWasmStatus(storage, wasmHash);
    if (!existing) return false;

    const index = entryIndexByReport(existing, params.reportUrl);
    if (index < 0) return false; // a newer verification already replaced this entry

    const entry = existing.source_code_verifications[index];
    const singular = legacySingularSourceUri(entry);
    const before = (entry.verified_source_code_uris ?? (singular ? [singular] : [])).map(toSourceCodeUri);
    if (before.some((uri) => uri.url === params.sourceCodeUri.url)) return false; // already present

    // The entry was located by *our own* report URL, so custody is about this entry and no other: the trust
    // level read from that report, and the result root we published under, which the draft shape had no field
    // for.
    const upgraded = upgradeLegacyEntry(entry, { ...params.legacyCustody, verifierUrl: storage.publicRoot });
    if (!upgraded) return false;
    const replacement = { ...upgraded, verified_source_code_uris: [...before, params.sourceCodeUri] };
    const updated = rewriteWasmStatus(existing, index, replacement, new Date().toISOString());
    if (!updated) return false;
    await writeJson(storage, wasmStatusKey(wasmHash), updated);
    return true;
  });
}

/** The index of the entry whose `results_urls` (either link form) names `reportUrl`, or -1. */
function entryIndexByReport(document: PeerRegistryStatusObject, reportUrl: string): number {
  return document.source_code_verifications.findIndex((entry) =>
    (entry.results_urls ?? []).some((link) => toResultUrl(link).url === reportUrl),
  );
}

/** Serializes every read-modify-write this module performs against ONE `wasms/{wasmHash}.json`. */
const wasmStatusLocks = new Map<string, Promise<unknown>>();

function withWasmStatusLock<T>(wasmHash: string, fn: () => Promise<T>): Promise<T> {
  const previous = wasmStatusLocks.get(wasmHash) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallow so a failed attempt does not poison the chain for the next caller on this hash — each caller still
  // observes its own rejection via the returned `next`.
  const tail = next.catch(() => undefined);
  wasmStatusLocks.set(wasmHash, tail);
  // Evict once settled, but only if nobody chained onto this hash in the meantime.
  void tail.finally(() => {
    if (wasmStatusLocks.get(wasmHash) === tail) wasmStatusLocks.delete(wasmHash);
  });
  return next;
}

async function writeJson(storage: ResultStorage, path: string, value: unknown): Promise<void> {
  await storage.writeText(path, `${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}
