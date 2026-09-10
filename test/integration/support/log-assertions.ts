/**
 * Build-log assertions shared by SUB-09, SUB-10, SUB-11, SUB-18 and SEC-06.
 *
 * The four path rules below, why they are split apart, and why `/source` and
 * `container_manifest_path` are deliberately absent: `docs/qa/cases/E2E-SUB.md`, E2E-SUB-10,
 * "How step 2's host paths become machine assertions".
 */
const SENSITIVE_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "AWS access-key id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "AWS secret field", pattern: /\baws[_-]?(?:secret|session[_-]?token)\b/i },
  { label: "Bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/i },
  { label: "password assignment", pattern: /\bpassword\s*[:=]\s*\S+/i },
  { label: "token assignment", pattern: /\btoken\s*[:=]\s*\S+/i },
  { label: "presigned query", pattern: /[?&]X-Amz-(?:Algorithm|Credential|Signature|Security-Token)=/i },
  {
    // Derived from `redactLocalPath`: it keeps the prefix and drops the segment, so the segment is the finding.
    label: "unredacted home directory",
    pattern: /\/(?:home|Users)\/(?!<redacted>(?:[/\s:"]|$))[^/\s:"]+/,
  },
  {
    // Derived from `redactLocalPath`: these five are collapsed whole, so a surviving tail is the
    // finding. `/private/(tmp|var)` keeps no second segment at all, hence the bare-prefix form.
    // `/var/run` joined this family — this service's own infrastructure (the
    // `docker.sock` case), the same class as the temp-dir families.
    label: "unredacted temp path",
    pattern:
      /\/(?:tmp|var\/tmp|var\/folders|var\/run)\/(?!<redacted>(?:[/\s:"]|$))[^/\s:"]+|\/private\/(?:tmp|var)\//,
  },
  {
    // Also derived from `redactLocalPath`, but anchored to a path start unlike the rule
    // above: `mnt` and `media` are ordinary words in a URL path segment or submitter subdirectory
    // name, so an unanchored match would flag legitimate content, not a leaked host path.
    label: "unredacted mount path",
    pattern: /(?:^|[^A-Za-z0-9._-])\/(?:mnt|media)\/(?!<redacted>(?:[/\s:"]|$))[^/\s:"]+/,
  },
  {
    // ★ NOT derived from `redactLocalPath`. `/workspace` is deliberately excluded from that
    // function: a submitter's own compiler error echoing `/workspace/…` must keep
    // failing this assertion as a signal, not be silently redacted.
    label: "host mount or runtime root",
    pattern: /\/workspace\//,
  },
  { label: "AWS metadata address", pattern: /\b169\.254\.169\.254\b/ },
  {
    label: "private IPv4 address",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
  },
  { label: "internal hostname", pattern: /\b[A-Za-z0-9.-]+\.(?:internal|local)\b/i },
];

/** Where a rule fired, without any of the text it fired on — the match may be the credential itself. */
function describeMatch(log: string, label: string, pattern: RegExp): string {
  const all = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const indices: number[] = [];
  for (const match of log.matchAll(all)) {
    if (match.index !== undefined) indices.push(match.index);
    if (indices.length >= 5) break;
  }
  const first =
    indices.length > 0
      ? `, first at byte ${Buffer.byteLength(log.slice(0, indices[0]), "utf8")}`
      : "";
  const more = indices.length >= 5 ? "5+" : String(indices.length);
  return `${label} (${more} match${indices.length === 1 ? "" : "es"}${first})`;
}

export function assertBuildLogRedacted(log: string): void {
  if (log.trim() === "") throw new Error("Build log is empty.");

  const matches = SENSITIVE_PATTERNS.filter(({ pattern }) => pattern.test(log)).map(({ label, pattern }) =>
    describeMatch(log, label, pattern)
  );
  if (matches.length > 0) {
    throw new Error(
      `Build log contains sensitive boundary data: ${matches.join(", ")}. ` +
        `Log is ${Buffer.byteLength(log, "utf8")} bytes; fetch it from the job's /log route and seek to the offset above.`
    );
  }
}

export function assertBuildLogContainsAny(
  log: string,
  label: string,
  patterns: readonly RegExp[]
): void {
  if (!patterns.some((pattern) => pattern.test(log))) {
    throw new Error(`Build log contains no ${label} marker.`);
  }
}
