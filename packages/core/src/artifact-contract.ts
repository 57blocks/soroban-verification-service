import { parseSchemaVersion } from "./validators/schema-version.js";

/** The `recipe.json` shape this build of the code writes and reads, as `MAJOR.MINOR`. */
export const BUILD_ARTIFACT_SCHEMA_VERSION = "1.0";

export const PRE_VERSIONED_BUILD_ARTIFACT_SCHEMA_VERSION = "0.0";

/** The reader declares a MAJOR below the document's. Terminal, and the reason a job fails visibly. */
export const ARTIFACT_SCHEMA_UNSUPPORTED = "artifact_schema_unsupported";

/** The bytes are there and are not a readable artifact. Also terminal, for the same reason. */
export const ARTIFACT_UNREADABLE = "artifact_unreadable";

/** A `schema_version` is a version string, so a long one is a sandbox writing something else. */
const MAX_REPORTED_VERSION_CHARS = 32;

export type BuildArtifactProbe =
  | { kind: "unreadable"; detail: string }
  | { kind: "unsupported"; declared: string; supported: string }
  | { kind: "readable"; declared: string; document: Record<string, unknown> };

/**
 * Reads `schema_version` off a `recipe.json` **without validating the rest of it**, which is the whole point: a
 * document from a builder ahead of this reader must fail as a known, terminal version mismatch rather than as
 * whichever field happens to have moved.
 */
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
