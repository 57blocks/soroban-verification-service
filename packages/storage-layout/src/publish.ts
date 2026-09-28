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
  type RegistryStatusObject,
} from "@scvs/core";
import { VerificationArtifact, VerifierManifest, VerifierPolicy } from "./shapes.js";
import { reportKey, sourceKey, verifierManifestKey, verifierPolicyKey, wasmStatusKey } from "./keys.js";
import { parsePeerWasmStatus, rewriteWasmStatus } from "./registry-status.js";
import type { ResultStorage } from "./storage-backend.js";

/** The one canonical byte serialization of a report artifact; its sha256 is the report's key. */
export function serializeReport(artifact: VerificationArtifact): { bytes: string; sha256: string } {
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

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
  bytes: Uint8Array;
  extension: string;
  contentType: string;
};

export async function publishSource(storage: ResultStorage, params: PublishSourceParams): Promise<void> {
  await storage.writeBytes(sourceKey(params.sourceSha256, params.extension), params.bytes, params.contentType);
}

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

/** Only `conflict` is worth retrying; `invalid-document` and `unrepresentable` need a human; the rest are settled. */
export type WasmStatusWriteResult =
  | "written"
  | "absent"
  | "superseded"
  | "already-present"
  | "unrepresentable"
  | "invalid-document"
  | "conflict";

type WasmStatusNoWrite = Extract<WasmStatusWriteResult, "absent" | "superseded" | "already-present" | "unrepresentable">;

type WasmStatusMutation = { write: RegistryStatusObject } | { skip: WasmStatusNoWrite };

const MUTATE_ATTEMPTS = 5;

/** `mutate` sees `undefined` only for a truly absent object; unparseable bytes end as `invalid-document` and are never overwritten. */
export async function mutateWasmStatus(
  storage: ResultStorage,
  wasmHash: string,
  mutate: (existing: PeerRegistryStatusObject | undefined) => WasmStatusMutation,
): Promise<WasmStatusWriteResult> {
  const key = wasmStatusKey(wasmHash);
  return withWasmStatusLock(wasmHash, async () => {
    for (let attempt = 1; attempt <= MUTATE_ATTEMPTS; attempt += 1) {
      const current = await storage.readTextVersioned(key);
      let existing: PeerRegistryStatusObject | undefined;
      if (current) {
        const parsed = parseDocument(current.text);
        if (!parsed) return "invalid-document";
        existing = parsed;
      }

      const decision = mutate(existing);
      if ("skip" in decision) return decision.skip;

      const outcome = await storage.writeTextIfUnchanged(
        key,
        serializeDocument(decision.write),
        "application/json; charset=utf-8",
        current?.version ?? null,
      );
      if (outcome === "written") return "written";
    }
    return "conflict";
  });
}

function parseDocument(text: string): PeerRegistryStatusObject | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parsePeerWasmStatus(raw);
}

export type AppendArchiveReferenceParams = {
  reportUrl: string;
  reportSha256: string;
  /** A directly fetchable gateway URL, never a bare `ar://` URI. */
  archiveUrl: string;
  legacyCustody?: LegacyCustody;
};

export async function appendArchiveReference(
  storage: ResultStorage,
  wasmHash: string,
  params: AppendArchiveReferenceParams,
): Promise<WasmStatusWriteResult> {
  return mutateWasmStatus(storage, wasmHash, (existing) => {
    if (!existing) return { skip: "absent" };

    const index = entryIndexByReport(existing, params.reportUrl);
    if (index < 0) return { skip: "superseded" };

    const entry = existing.source_code_verifications[index];
    const links = (entry.results_urls ?? []).map(toResultUrl);
    if (links.some((link) => link.url === params.archiveUrl)) return { skip: "already-present" };

    const upgraded = upgradeLegacyEntry(entry, { ...params.legacyCustody, verifierUrl: storage.publicRoot });
    if (!upgraded) return { skip: "unrepresentable" };
    // `upgraded.results_urls`, not `links`: the upgrade narrows a peer's open link vocabulary to the producer's closed one.
    const replacement = {
      ...upgraded,
      results_urls: [
        ...(upgraded.results_urls ?? []),
        { type: "report" as const, location: "arweave" as const, url: params.archiveUrl, sha256: params.reportSha256 },
      ],
    };
    const updated = rewriteWasmStatus(existing, index, replacement, new Date().toISOString());
    return updated ? { write: updated } : { skip: "unrepresentable" };
  });
}

export type AppendVerifiedSourceCodeUriParams = {
  reportUrl: string;
  sourceCodeUri: RegistrySourceCodeUri;
  legacyCustody?: LegacyCustody;
};

export async function appendVerifiedSourceCodeUri(
  storage: ResultStorage,
  wasmHash: string,
  params: AppendVerifiedSourceCodeUriParams,
): Promise<WasmStatusWriteResult> {
  return mutateWasmStatus(storage, wasmHash, (existing) => {
    if (!existing) return { skip: "absent" };

    const index = entryIndexByReport(existing, params.reportUrl);
    if (index < 0) return { skip: "superseded" };

    const entry = existing.source_code_verifications[index];
    const singular = legacySingularSourceUri(entry);
    const before = (entry.verified_source_code_uris ?? (singular ? [singular] : [])).map(toSourceCodeUri);
    if (before.some((uri) => uri.url === params.sourceCodeUri.url)) return { skip: "already-present" };

    const upgraded = upgradeLegacyEntry(entry, { ...params.legacyCustody, verifierUrl: storage.publicRoot });
    if (!upgraded) return { skip: "unrepresentable" };
    const replacement = { ...upgraded, verified_source_code_uris: [...before, params.sourceCodeUri] };
    const updated = rewriteWasmStatus(existing, index, replacement, new Date().toISOString());
    return updated ? { write: updated } : { skip: "unrepresentable" };
  });
}

function entryIndexByReport(document: PeerRegistryStatusObject, reportUrl: string): number {
  return document.source_code_verifications.findIndex((entry) =>
    (entry.results_urls ?? []).some((link) => toResultUrl(link).url === reportUrl),
  );
}

/** An in-process fast path only; the compare-and-swap in `mutateWasmStatus` is the actual guarantee. */
const wasmStatusLocks = new Map<string, Promise<unknown>>();

function withWasmStatusLock<T>(wasmHash: string, fn: () => Promise<T>): Promise<T> {
  const previous = wasmStatusLocks.get(wasmHash) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallowed so one failure does not poison the chain; each caller still sees its own rejection via `next`.
  const tail = next.catch(() => undefined);
  wasmStatusLocks.set(wasmHash, tail);
  void tail.finally(() => {
    if (wasmStatusLocks.get(wasmHash) === tail) wasmStatusLocks.delete(wasmHash);
  });
  return next;
}

async function writeJson(storage: ResultStorage, path: string, value: unknown): Promise<void> {
  await storage.writeText(path, serializeDocument(value), "application/json; charset=utf-8");
}

function serializeDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
