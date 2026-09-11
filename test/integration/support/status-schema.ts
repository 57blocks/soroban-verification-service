/**
 * This intentionally does not import @scvs/core: importing the producer's own DTO would let both sides of the
 * publication test silently agree on the same contract, correct or not.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "..", "..", "docs", "results-sep", "schemas", "stellar-verification-status-1.0.schema.json");

type Schema = {
  required: string[];
  properties: Record<string, { const?: string }>;
  $defs: {
    verification: { required: string[]; properties: Record<string, { enum?: string[] }> };
    result_url: { required: string[]; properties: Record<string, { enum?: string[] }> };
    source_code_uri: { required: string[]; properties: Record<string, { enum?: string[] }> };
    verifier: { required: string[]; properties: Record<string, unknown> };
  };
};
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;

const HASH64 = /^[0-9a-f]{64}$/;
const BLDOPT = /^--[A-Za-z][A-Za-z0-9_-]*(=.+)?$/;
const BLDIMG = /^(?:localhost(?::\d+)?|[^\s@/]*[.:][^\s@/]*)\/[^\s@]+@sha256:[0-9a-f]{64}$/;

const STATUSES = schema.$defs.verification.properties.status.enum!;
const RECIPE_SOURCES = schema.$defs.verification.properties.recipe_source.enum!;
/**
 * Read from the schema file, and exported so a case asserting the signal is stated cannot drift from
 * the document that defines it — the same reason the validator below reads every other enum here.
 */
export const IMAGE_TRUST_LEVELS = schema.$defs.verification.properties.image_trust_level.enum!;
const RESULT_URL_TYPES = schema.$defs.result_url.properties.type.enum!;
const RESULT_URL_LOCATIONS = schema.$defs.result_url.properties.location.enum!;
const SOURCE_CODE_URI_LOCATIONS = schema.$defs.source_code_uri.properties.location.enum!;
const ENTRY_KEYS = Object.keys(schema.$defs.verification.properties);
const VERIFIER_KEYS = Object.keys(schema.$defs.verifier.properties);
const RESULT_URL_KEYS = Object.keys(schema.$defs.result_url.properties);
const SOURCE_CODE_URI_KEYS = Object.keys(schema.$defs.source_code_uri.properties);
/** SO3 — present exactly when the entry carries a verdict (mirrors the schema's if/then/else). */
const VERDICT_CONDITIONAL = ["recipe_source", "image_trust_level", "source_sha256", "processed_at"] as const;

type JsonObject = Record<string, unknown>;

function object(value: unknown, path: string, errors: string[]): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  return value as JsonObject;
}

function required(value: JsonObject, keys: readonly string[], path: string, errors: string[]) {
  for (const key of keys) if (!(key in value)) errors.push(`${path}.${key} is required`);
}

function closed(value: JsonObject, allowed: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not declared by the Results SEP schema`);
  }
}

function uri(value: unknown, path: string, errors: string[]) {
  if (typeof value !== "string") {
    errors.push(`${path} must be a URI string`);
    return;
  }
  try {
    new URL(value); // open schemes (ar://, ipfs://) are legitimate
  } catch {
    errors.push(`${path} must be an absolute URI`);
  }
}

function dateTime(value: unknown, path: string, errors: string[]) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || !/[TZz]|[+-]\d\d:\d\d$/.test(value)) {
    errors.push(`${path} must be an RFC 3339 date-time`);
  }
}

function validateVerifier(value: unknown, path: string, errors: string[]) {
  const verifier = object(value, path, errors);
  if (!verifier) return;
  required(verifier, schema.$defs.verifier.required, path, errors);
  closed(verifier, VERIFIER_KEYS, path, errors);
  // `url` is the identity and is required; `name` is self-claimed and optional.
  uri(verifier.url, `${path}.url`, errors);
  if ("name" in verifier && (typeof verifier.name !== "string" || verifier.name.length === 0)) {
    errors.push(`${path}.name must be non-empty when present`);
  }
  if ("logo_url" in verifier) {
    if (typeof verifier.logo_url === "string") uri(verifier.logo_url, `${path}.logo_url`, errors);
    else {
      const logo = object(verifier.logo_url, `${path}.logo_url`, errors);
      if (!logo) return;
      closed(logo, ["light", "dark"], `${path}.logo_url`, errors);
      if (Object.keys(logo).length === 0) errors.push(`${path}.logo_url must contain light or dark`);
      for (const key of ["light", "dark"] as const) if (key in logo) uri(logo[key], `${path}.logo_url.${key}`, errors);
    }
  }
}

function validateResultUrl(value: unknown, path: string, errors: string[]) {
  const link = object(value, path, errors);
  if (!link) return;
  required(link, schema.$defs.result_url.required, path, errors);
  closed(link, RESULT_URL_KEYS, path, errors);
  if (typeof link.type !== "string" || !RESULT_URL_TYPES.includes(link.type)) errors.push(`${path}.type is not a Results SEP link type`);
  if ("location" in link && (typeof link.location !== "string" || !RESULT_URL_LOCATIONS.includes(link.location))) {
    errors.push(`${path}.location is not a Results SEP link location`);
  }
  uri(link.url, `${path}.url`, errors);
  if ("sha256" in link && (typeof link.sha256 !== "string" || !HASH64.test(link.sha256))) errors.push(`${path}.sha256 must be lowercase SHA-256`);
}

function validateSourceCodeUri(value: unknown, path: string, errors: string[]) {
  const link = object(value, path, errors);
  if (!link) return;
  required(link, schema.$defs.source_code_uri.required, path, errors);
  closed(link, SOURCE_CODE_URI_KEYS, path, errors);
  if (typeof link.location !== "string" || !SOURCE_CODE_URI_LOCATIONS.includes(link.location)) {
    errors.push(`${path}.location is not a Results SEP source-code-uri location`);
  }
  uri(link.url, `${path}.url`, errors);
  if ("sha256" in link && (typeof link.sha256 !== "string" || !HASH64.test(link.sha256))) errors.push(`${path}.sha256 must be lowercase SHA-256`);
}

function validateEntry(value: unknown, index: number, errors: string[]) {
  const path = `source_code_verifications[${index}]`;
  const entry = object(value, path, errors);
  if (!entry) return;
  required(entry, schema.$defs.verification.required, path, errors);
  closed(entry, ENTRY_KEYS, path, errors);
  validateVerifier(entry.verifier, `${path}.verifier`, errors);

  const status = entry.status;
  if (typeof status !== "string" || !STATUSES.includes(status)) errors.push(`${path}.status is not a Results SEP status`);
  const verdict = status !== "unverified";

  // SO3 — the four verdict-conditional fields.
  for (const field of VERDICT_CONDITIONAL) {
    if (verdict && !(field in entry)) errors.push(`${path}.${field} is required for a verdict`);
  }
  // SO3's other half: an unverified entry is *exactly* `{verifier, status}`. Checking only the four
  // left `bldimg`/`bldopt`/`results_urls` publishable on an entry that by definition has none — the
  // schema's `if/then` was equally loose until 2026-09-08 and now says the same thing this does.
  if (!verdict) {
    for (const key of Object.keys(entry)) {
      if (key !== "verifier" && key !== "status") errors.push(`${path}.${key} is forbidden for unverified`);
    }
  }
  // SO2.
  if (status === "mismatched" && !("rebuilt_hash" in entry)) errors.push(`${path}.rebuilt_hash is required for mismatched`);
  if (status !== "mismatched" && "rebuilt_hash" in entry) errors.push(`${path}.rebuilt_hash is only allowed for mismatched`);

  if ("recipe_source" in entry && (typeof entry.recipe_source !== "string" || !RECIPE_SOURCES.includes(entry.recipe_source))) errors.push(`${path}.recipe_source is not a recipe source`);
  if ("image_trust_level" in entry && (typeof entry.image_trust_level !== "string" || !IMAGE_TRUST_LEVELS.includes(entry.image_trust_level))) errors.push(`${path}.image_trust_level is not a trust level`);
  if ("source_sha256" in entry && (typeof entry.source_sha256 !== "string" || !HASH64.test(entry.source_sha256))) errors.push(`${path}.source_sha256 must be lowercase SHA-256`);
  if ("source_uri" in entry && (typeof entry.source_uri !== "string" || entry.source_uri.length === 0)) errors.push(`${path}.source_uri must be a non-empty string`);
  if ("verified_source_code_uris" in entry) {
    if (!Array.isArray(entry.verified_source_code_uris)) errors.push(`${path}.verified_source_code_uris must be an array`);
    else
      entry.verified_source_code_uris.forEach((item, i) =>
        validateSourceCodeUri(item, `${path}.verified_source_code_uris[${i}]`, errors),
      );
  }
  if ("rebuilt_hash" in entry && (typeof entry.rebuilt_hash !== "string" || !HASH64.test(entry.rebuilt_hash))) errors.push(`${path}.rebuilt_hash has invalid format`);
  if ("processed_at" in entry) dateTime(entry.processed_at, `${path}.processed_at`, errors);
  if ("bldimg" in entry && (typeof entry.bldimg !== "string" || !BLDIMG.test(entry.bldimg))) errors.push(`${path}.bldimg has invalid format`);
  if ("bldarg" in entry && (!Array.isArray(entry.bldarg) || !entry.bldarg.every((item) => typeof item === "string"))) errors.push(`${path}.bldarg must be an array of strings`);
  if ("bldopt" in entry && (!Array.isArray(entry.bldopt) || !entry.bldopt.every((item) => typeof item === "string" && BLDOPT.test(item)))) errors.push(`${path}.bldopt contains an invalid option`);
  if ("results_urls" in entry) {
    if (!Array.isArray(entry.results_urls)) errors.push(`${path}.results_urls must be an array`);
    else entry.results_urls.forEach((item, i) => validateResultUrl(item, `${path}.results_urls[${i}]`, errors));
  }
}

/** Returns every conformance error; an empty list means the document satisfies the schema. */
export function validateSepStatusObject(value: unknown): string[] {
  const errors: string[] = [];
  const document = object(value, "$", errors);
  if (!document) return errors;
  required(document, schema.required, "$", errors);
  closed(document, Object.keys(schema.properties), "$", errors);
  if (document.schema !== schema.properties.schema.const) errors.push(`$.schema must equal ${schema.properties.schema.const}`);
  if (document.schema_version !== schema.properties.schema_version.const) errors.push(`$.schema_version must equal ${schema.properties.schema_version.const}`);
  if (typeof document.wasm_hash !== "string" || !HASH64.test(document.wasm_hash)) errors.push("$.wasm_hash must be lowercase SHA-256");
  if ("updated_at" in document) dateTime(document.updated_at, "$.updated_at", errors);
  if (!Array.isArray(document.source_code_verifications) || document.source_code_verifications.length < 1) {
    errors.push("$.source_code_verifications must contain at least one entry");
  } else document.source_code_verifications.forEach((entry, index) => validateEntry(entry, index, errors));
  return errors;
}

/**
 * @deprecated name kept for the E2E case that imported it; the schema it validates is the Results SEP's.
 */
export const validateTrdStatusObject = validateSepStatusObject;
