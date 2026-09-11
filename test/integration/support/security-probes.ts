/**
 * P8 Operations inputs for controls the public API must never expose: build-fleet IAM state and
 * credential-bearing presigned URLs.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

export interface Sec09Evidence {
  readonly jobId: string;
  readonly database: { readonly credentialPresent: false; readonly outcome: "denied" | "unreachable" };
  readonly resultBucket: { readonly get: "denied"; readonly put: "denied" };
  readonly publishingKey: {
    readonly environment: false;
    readonly credentialsFile: false;
    readonly imds: "unreachable";
    readonly mountedSecrets: false;
  };
  readonly unexpectedOutboundDestinations: readonly string[];
}

export interface Sec10Capture {
  readonly capturedAtMs: number;
  readonly targets: Readonly<
    Record<
      "recipe" | "rebuilt_wasm",
      { readonly url: string; readonly contentType: "application/json" | "application/wasm"; readonly consumedAtMs: number }
    >
  >;
  readonly control: { readonly url: string; readonly contentType: string; readonly expiresAtMs: number };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProbeFile(variable: string): JsonRecord {
  const configured = process.env[variable]?.trim();
  if (!configured) throw new Error(`${variable} is not set.`);
  const path = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  if (!existsSync(path)) throw new Error(`${variable} points to a file that does not exist.`);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("root is not an object");
    return parsed;
  } catch (error) {
    throw new Error(
      `${variable} is not valid probe JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Probe field ${field} must be an object.`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Probe field ${field} must be a non-empty string.`);
  }
  return value;
}

function literal<T extends string | boolean>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`Probe field ${field} must be ${JSON.stringify(expected)}.`);
  return expected;
}

function timestamp(value: unknown, field: string): number {
  const parsed = Date.parse(string(value, field));
  if (!Number.isFinite(parsed)) throw new Error(`Probe field ${field} must be an ISO-8601 timestamp.`);
  return parsed;
}

/** Reads a P8 export tied to the diagnostic Batch job named by SCVS_E2E_SEC09_JOB_ID. */
export function readSec09Evidence(): Sec09Evidence {
  const root = readProbeFile("SCVS_E2E_SEC09_EVIDENCE_PATH");
  literal(root.schema, "scvs-e2e-sec09-v1", "schema");
  const database = record(root.database, "database");
  const resultBucket = record(root.result_bucket, "result_bucket");
  const publishingKey = record(root.publishing_key, "publishing_key");
  const network = record(root.network, "network");
  const unexpected = network.unexpected_outbound_destinations;
  if (!Array.isArray(unexpected) || !unexpected.every((destination) => typeof destination === "string")) {
    throw new Error("Probe field network.unexpected_outbound_destinations must be a string array.");
  }
  const databaseOutcome = string(database.outcome, "database.outcome");
  if (databaseOutcome !== "denied" && databaseOutcome !== "unreachable") {
    throw new Error('Probe field database.outcome must be "denied" or "unreachable".');
  }

  return {
    jobId: string(root.job_id, "job_id"),
    database: {
      credentialPresent: literal(database.credential_present, false, "database.credential_present"),
      outcome: databaseOutcome,
    },
    resultBucket: {
      get: literal(resultBucket.get, "denied", "result_bucket.get"),
      put: literal(resultBucket.put, "denied", "result_bucket.put"),
    },
    publishingKey: {
      environment: literal(publishingKey.environment, false, "publishing_key.environment"),
      credentialsFile: literal(publishingKey.credentials_file, false, "publishing_key.credentials_file"),
      imds: literal(publishingKey.imds, "unreachable", "publishing_key.imds"),
      mountedSecrets: literal(publishingKey.mounted_secrets, false, "publishing_key.mounted_secrets"),
    },
    unexpectedOutboundDestinations: unexpected,
  };
}

function signedUrl(value: unknown, field: string): string {
  const candidate = string(value, field);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Probe field ${field} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Probe field ${field} must use HTTPS.`);
  return candidate;
}

/** Reads the two consumed runner URLs plus one disposable control URL from the P8 exporter. */
export function readSec10Capture(): Sec10Capture {
  const root = readProbeFile("SCVS_E2E_SEC10_CAPTURE_PATH");
  literal(root.schema, "scvs-e2e-sec10-v1", "schema");
  const targets = record(root.targets, "targets");
  const parseTarget = (name: "recipe" | "rebuilt_wasm") => {
    const target = record(targets[name], `targets.${name}`);
    const rawContentType = string(target.content_type, `targets.${name}.content_type`);
    if (rawContentType !== "application/json" && rawContentType !== "application/wasm") {
      throw new Error(`Probe field targets.${name}.content_type must be application/json or application/wasm.`);
    }
    const contentType: "application/json" | "application/wasm" = rawContentType;
    return {
      url: signedUrl(target.url, `targets.${name}.url`),
      contentType,
      consumedAtMs: timestamp(target.consumed_at, `targets.${name}.consumed_at`),
    };
  };
  const control = record(root.control, "control");
  const parsed = {
    capturedAtMs: timestamp(root.captured_at, "captured_at"),
    targets: { recipe: parseTarget("recipe"), rebuilt_wasm: parseTarget("rebuilt_wasm") },
    control: {
      url: signedUrl(control.url, "control.url"),
      contentType: string(control.content_type, "control.content_type"),
      expiresAtMs: timestamp(control.expires_at, "control.expires_at"),
    },
  };
  if (parsed.control.expiresAtMs <= Date.now()) {
    throw new Error("SEC-10 control URL is already expired; capture a new probe file immediately before the run.");
  }
  if (parsed.control.expiresAtMs <= parsed.capturedAtMs) {
    throw new Error("Probe field control.expires_at must be after captured_at.");
  }
  return parsed;
}
