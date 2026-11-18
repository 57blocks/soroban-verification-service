import { SEP58_BLDOPT_ENTRY, SOURCE_URI_PATTERN, extractManifestPath, refusedEnvAssignment, repeatedBuildOption, resolveContainerManifestPath } from "@scvs/core";
import type { SubmittedSourceManifest, VerificationTarget } from "@scvs/core";

export type ManifestValidation =
  | { ok: true; manifest: SubmittedSourceManifest }
  | { ok: false; error: string; detail: string };

/**
 * A contract is read by the Wasm it runs now, so a `wasm_hash` named beside its `contract_id` must be that Wasm:
 * the recipe and source binding read from the chain are the deployed Wasm's, never the named one's.
 */
export function compareTargetAgainstChain(
  target: { contract_id?: string; wasm_hash?: string },
  deployedWasmHash: string | undefined,
): ManifestValidation | { ok: true } {
  if (!target.contract_id || !target.wasm_hash || !deployedWasmHash) return { ok: true };
  if (target.wasm_hash.toLowerCase() === deployedWasmHash.toLowerCase()) return { ok: true };
  return invalid(
    "target_wasm_not_deployed",
    `Contract ${target.contract_id} runs Wasm ${deployedWasmHash.toLowerCase()}, not the ${target.wasm_hash.toLowerCase()} ` +
      "this submission named. Submit the contract alone to verify the Wasm it runs, or the Wasm hash alone to verify that Wasm.",
  );
}

export function compareSourceAgainstChain(
  chainSourceSha256: string | undefined,
  submittedSha256: string,
): ManifestValidation | { ok: true } {
  if (!chainSourceSha256) return { ok: true };
  if (chainSourceSha256.toLowerCase() === submittedSha256.toLowerCase()) return { ok: true };

  return invalid(
    "source_archive_not_chain_recorded",
    `The source archive you submitted hashes to ${submittedSha256.toLowerCase()}, but this contract ` +
      `records source_sha256=${chainSourceSha256.toLowerCase()} on chain.`,
  );
}

const HEX_64_RE = /^[0-9a-f]{64}$/i;
const BLDIMG_RE = /^(?:localhost(?::\d+)?|[^\s@/]*[.:][^\s@/]*\/)[^\s@]+(?::[^\s@]+)?(?:@sha256:[0-9a-f]{64})?$/i;
const SOURCE_URI_RE = SOURCE_URI_PATTERN;

export function validateSubmittedManifest(
  value: unknown,
  target: VerificationTarget,
): ManifestValidation {
  if (!isRecord(value)) {
    return invalid("invalid_manifest", "manifest must be an object.");
  }

  if (value.schema !== "stellar-submitted-source-verification-manifest-v1") {
    return invalid(
      "invalid_manifest",
      "manifest.schema must be 'stellar-submitted-source-verification-manifest-v1'.",
    );
  }

  if (value.bldimg !== undefined && (typeof value.bldimg !== "string" || !BLDIMG_RE.test(value.bldimg))) {
    return invalid(
      "invalid_manifest",
      "manifest.bldimg must be a fully-qualified image reference with an explicit registry host, e.g. docker.io/stellar/stellar-cli@sha256:... (SEP-58 §1).",
    );
  }

  if (value.bldarg !== undefined) {
    if (!Array.isArray(value.bldarg) || !value.bldarg.every((a) => typeof a === "string" && a.length > 0)) {
      return invalid("invalid_manifest", "manifest.bldarg must be an array of non-empty strings when provided (SEP-58 §1).");
    }
  }

  if (value.bldopt !== undefined) {
    if (!Array.isArray(value.bldopt) || !value.bldopt.every((f) => typeof f === "string")) {
      return invalid("invalid_manifest", "manifest.bldopt must be an array of strings when provided (SEP-58 §1).");
    }
    const shape = firstBldoptShapeViolation(value.bldopt as string[]);
    if (shape) return invalid("invalid_manifest", shape);

    const repeated = repeatedBuildOption(value.bldopt as string[]);
    if (repeated) return invalid("invalid_manifest", `manifest.${repeated}`);

    for (const entry of value.bldopt as string[]) {
      const assignment = /^--env=(.*)$/s.exec(entry)?.[1];
      const refusal = assignment === undefined ? undefined : refusedEnvAssignment(assignment);
      if (refusal) return invalid("policy_rejected", `manifest.bldopt: ${refusal}`);
    }

    const manifestPath = extractManifestPath(value.bldopt as string[]);
    if (manifestPath !== undefined) {
      const containment = resolveContainerManifestPath(manifestPath);
      if (!containment.ok) return invalid("policy_rejected", containment.detail);
    }
  }

  if (typeof value.source_sha256 !== "string" || !HEX_64_RE.test(value.source_sha256)) {
    return invalid(
      "invalid_manifest",
      "manifest.source_sha256 is required and must be a 64-character hex string (SEP-58 §2).",
    );
  }

  if (value.source_uri !== undefined) {
    if (typeof value.source_uri !== "string" || !SOURCE_URI_RE.test(value.source_uri)) {
      return invalid(
        "invalid_manifest",
        "manifest.source_uri must be a valid URI when provided, e.g. https://example.com/source.tar.gz",
      );
    }
  }

  if (value.upload_id !== undefined) {
    if (typeof value.upload_id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.upload_id)) {
      return invalid("invalid_manifest", "manifest.upload_id must be a valid upload handle.");
    }
  }

  if (!value.source_uri && !value.upload_id) {
    return invalid(
      "invalid_manifest",
      "manifest must include source_uri or upload_id so the verifier can fetch the exact source archive.",
    );
  }

  if (value.is_public !== undefined && typeof value.is_public !== "boolean") {
    return invalid("invalid_manifest", "manifest.is_public must be a boolean when provided.");
  }

  const credentials = value.is_public === true && typeof value.source_uri === "string" ? uriCredentials(value.source_uri) : undefined;
  if (credentials) {
    return invalid(
      "invalid_manifest",
      `manifest.source_uri carries ${credentials}, and a public submission publishes its source_uri. ` +
        "Remove it, or submit with is_public: false.",
    );
  }

  return {
    ok: true,
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1",
      target,
      ...(typeof value.bldimg === "string" ? { bldimg: value.bldimg } : {}),
      bldarg: value.bldarg as string[] | undefined,
      bldopt: value.bldopt as string[] | undefined,
      source_sha256: (value.source_sha256 as string).toLowerCase(),
      source_uri: value.source_uri as string | undefined,
      upload_id: value.upload_id as string | undefined,
      is_public: (value.is_public as boolean | undefined) ?? false,
    },
  };
}

/** Each `bldopt` entry is one complete flag, with its value in `=` form. */
function firstBldoptShapeViolation(bldopt: string[]): string | undefined {
  const rule =
    "SEP-58 §1 records one complete flag per entry, with its value in `=` form, which is the shape the published status object requires.";

  for (let index = 0; index < bldopt.length; index += 1) {
    const entry = bldopt[index];
    if (SEP58_BLDOPT_ENTRY.test(entry)) continue;

    const previous = index > 0 ? bldopt[index - 1] : undefined;
    if (previous && /^--[A-Za-z][A-Za-z0-9_-]*$/.test(previous) && !entry.startsWith("-")) {
      return `manifest.bldopt entry ${JSON.stringify(entry)} is a bare value, not a flag: ${rule} Write ${JSON.stringify(`${previous}=${entry}`)} as a single entry rather than ${JSON.stringify(previous)} and its value separately.`;
    }

    if (/^-[A-Za-z]/.test(entry)) {
      return `manifest.bldopt entry ${JSON.stringify(entry)} is a short flag, which the status object cannot represent: ${rule} Use the long form, e.g. \`--package=my-contract\` rather than \`-p my-contract\`.`;
    }

    return `manifest.bldopt entry ${JSON.stringify(entry)} is not a complete flag: ${rule}`;
  }

  return undefined;
}

const CREDENTIAL_QUERY_KEYS = new Set([
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
  "sig",
  "signature",
  "token",
  "access_token",
  "api_key",
  "apikey",
]);

/** What in a URL would let a reader of the published result fetch with someone else's access. */
function uriCredentials(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return "a user name or password";
  const key = [...url.searchParams.keys()].find((name) => CREDENTIAL_QUERY_KEYS.has(name.toLowerCase()));
  return key ? `a credential in its query string (${key})` : undefined;
}

function invalid(error: string, detail: string): ManifestValidation {
  return { ok: false, error, detail };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
