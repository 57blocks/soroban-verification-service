/** Input is truncated to this before any regex runs; its size is attacker-chosen. */
const MAX_REDACTED_INPUT = 64 * 1024;

/** Bounds the scheme match so it stays linear. */
const MAX_SCHEME = 15;

// A home directory loses one segment; temp and infrastructure paths go whole. `/mnt`/`/media` match only at a
// path start. `/workspace` is not redacted: a submitter's compiler errors echoing it must stay visible.
export function redactLocalPath(value: string): string {
  return value
    .replace(/\/Users\/[^/\s:"]+/g, "/Users/<redacted>")
    .replace(/\/home\/[^/\s:"]+/g, "/home/<redacted>")
    .replace(/\/private\/(?:tmp|var)\/[^\s:"]+/g, "/private/<tmp>")
    .replace(/\/var\/folders\/[^\s:"]+/g, "/var/folders/<redacted>")
    .replace(/\/var\/tmp\/[^\s:"]+/g, "/var/tmp/<redacted>")
    .replace(/\/var\/run\/[^\s:"]+/g, "/var/run/<redacted>")
    .replace(/(^|[^A-Za-z0-9._-])\/mnt\/[^\s:"]+/g, "$1/mnt/<redacted>")
    .replace(/(^|[^A-Za-z0-9._-])\/media\/[^\s:"]+/g, "$1/media/<redacted>")
    .replace(/\/tmp\/[^\s:"]+/g, "/tmp/<redacted>");
}

const URL_TERMINATOR = "\\s\"'`<>()\\[\\]{},;";

export function redactSecrets(value: string): string {
  return (
    value
      // Host and path survive; userinfo, query and fragment do not.
      .replace(
        new RegExp(
          `(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,${MAX_SCHEME}}://)` +
            `(?:[^${URL_TERMINATOR}/@]{0,256}@)?` +
            `([^${URL_TERMINATOR}/?#]{0,256})` +
            `([^${URL_TERMINATOR}?#]{0,1024})` +
            `(\\?[^${URL_TERMINATOR}]{0,4096})?` +
            `(#[^${URL_TERMINATOR}]{0,4096})?`,
          "gi",
        ),
        (_m, scheme: string, host: string, path: string, query?: string, fragment?: string) =>
          `${scheme}${host}${path}${query || fragment ? "?<redacted>" : ""}`,
      )
      // To end of line: the value is `<scheme> <credential>`, so one token would leave the credential.
      .replace(/\b(Authorization\s*:\s*).*/gi, "$1<redacted>")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{1,4096}/gi, "$1 <redacted>")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>")
      .replace(/\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}/g, "<redacted-jwt>")
      // `eyJwYXlsb2FkIjoi` is the base64 of `{"payload":"`, the ECR token envelope prefix.
      .replace(/\beyJwYXlsb2FkIjoi[A-Za-z0-9+/=_-]{64,8192}/g, "<redacted-ecr-token>")
      .replace(/\d{12}(?=\.dkr\.ecr\.)/g, "<redacted-aws-account>")
      // The 8-character minimum leaves the public `amazon-ecs-agent` image intact.
      .replace(/\becs-[a-z0-9-]{8,128}\b/g, "<redacted-ecs-name>")
      .replace(
        /(?<![A-Za-z0-9])(SCVS_[A-Z0-9_]{1,64}\s*=\s*)("[^"]{0,4096}"|'[^']{0,4096}'|[^\s]{1,4096})/gi,
        "$1<redacted>",
      )
      // No leading `\b`: `_` is a word character, so it would skip GITHUB_TOKEN and AWS_SESSION_TOKEN.
      .replace(
        /(?<![A-Za-z0-9])([A-Za-z0-9_-]{0,32}(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]{0,32}\s*[=:]\s*)("[^"]{0,4096}"|'[^']{0,4096}'|[^\s]{1,4096})/gi,
        "$1<redacted>",
      )
  );
}

export function redactAll(value: string, maxInput: number = MAX_REDACTED_INPUT): string {
  const bounded = value.length > maxInput ? value.slice(0, maxInput) : value;
  return redactSecrets(redactLocalPath(bounded));
}

export function redactCommand(command: string[]): string[] {
  // Not `map(redactAll)`: the index would bind to `maxInput`.
  return command.map((entry) => redactAll(entry));
}

export function summarizeGenericCommand(command: string[]): string {
  return redactCommand(command).join(" ");
}

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return "<redacted-depth>";
  if (typeof value === "string") return redactAll(value);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactUnknown(entry, depth + 1),
      ]),
    );
  }
  return value;
}

export function excerpt(value: string, maxLength = 1_200): string | undefined {
  const normalized = redactAll(value).trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  const head = normalized.slice(0, Math.floor(maxLength / 2)).trimEnd();
  const tail = normalized.slice(-Math.floor(maxLength / 2)).trimStart();
  return `${head}\n... truncated ...\n${tail}`;
}
