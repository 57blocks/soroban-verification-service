import { parseSchemaVersion } from "./validators/schema-version.js";

export const BUILD_ARTIFACT_SCHEMA_VERSION = "1.0";

export const PRE_VERSIONED_BUILD_ARTIFACT_SCHEMA_VERSION = "0.0";

export const ARTIFACT_SCHEMA_UNSUPPORTED = "artifact_schema_unsupported";

export const ARTIFACT_UNREADABLE = "artifact_unreadable";

const MAX_REPORTED_VERSION_CHARS = 32;

export type BuildArtifactProbe =
  | { kind: "unreadable"; detail: string }
  | { kind: "unsupported"; declared: string; supported: string }
  | { kind: "readable"; declared: string; document: Record<string, unknown> };

/** Reads only `schema_version`, never validating the rest, so a newer builder's document fails as a version mismatch. */
export function probeBuildArtifactDocument(
  text: string,
  supported: string = BUILD_ARTIFACT_SCHEMA_VERSION,
): BuildArtifactProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "unreadable", detail: `not JSON (${error instanceof Error ? error.message : "parse failed"})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", detail: `a JSON ${Array.isArray(parsed) ? "array" : typeof parsed}, not an object` };
  }

  const document = parsed as Record<string, unknown>;
  const raw = document.schema_version;
  if (raw !== undefined && typeof raw !== "string") {
    return { kind: "unreadable", detail: `schema_version is a ${typeof raw}, not a MAJOR.MINOR string` };
  }

  const declared = raw ?? PRE_VERSIONED_BUILD_ARTIFACT_SCHEMA_VERSION;
  const version = parseSchemaVersion(declared);
  if (version === undefined) {
    return { kind: "unreadable", detail: `schema_version ${JSON.stringify(clip(declared))} is not MAJOR.MINOR` };
  }

  const mine = parseSchemaVersion(supported);
  if (mine === undefined) throw new Error(`supported schema version ${supported} is not MAJOR.MINOR`);
  if (version.major > mine.major) {
    return { kind: "unsupported", declared: clip(declared), supported };
  }
  return { kind: "readable", declared, document };
}

function clip(value: string): string {
  return value.length > MAX_REPORTED_VERSION_CHARS ? `${value.slice(0, MAX_REPORTED_VERSION_CHARS)}…` : value;
}
