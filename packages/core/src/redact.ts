// Text redaction for anything that might carry a credential, a presigned URL, or a local path.

/**
 * How much text is redacted at all. Every regex below is linear, but they still run over build output an
 * attacker chooses the size of, so the input is bounded before any of them sees it.
 */
const MAX_REDACTED_INPUT = 64 * 1024;

/** Longest scheme we will match. Real ones are under 10 characters; the bound keeps matching linear. */
const MAX_SCHEME = 15;

/**
 * Local paths, with the two families treated differently on purpose. A home directory leaks one
 * name, so one segment goes; a temp path goes whole, because its tail is the submitter's own (S22).
 *
 * `/var/run` and `/mnt`/`/media` join the temp family for the same reason: they name this
 * service's own infrastructure, not submitter content — `/var/run/docker.sock`
 * (`docker/builder-entrypoint.sh`) is the concrete case. Unlike the others, `/mnt` and `/media` are
 * anchored to a path start: both words are also ordinary URL path segments or submitter
 * subdirectory names (`/media/img.png`, `src/media/`), so an unanchored match would redact
 * legitimate content instead of a host path.
 *
 * `/workspace` is deliberately **not** here: `docs/qa/cases/E2E-SUB.md`'s E2E-SUB-10 section
 * documents that a submitter's own compiler error echoing `/workspace/…` must keep failing the
 * build-log assertion as a signal, not be swept away by this function.
 */
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

/** Where a URL's authority or path ends. Excludes the delimiters that surround URLs in log prose. */
const URL_TERMINATOR = "\\s\"'`<>()\\[\\]{},;";

/** Credentials, and anything shaped like one, in text the submitter can influence. */
export function redactSecrets(value: string): string {
  return (
    value
      // scheme://[userinfo@]host/path[?query][#fragment]. Host and path survive — they are what makes a
      // diagnostic useful and neither is a secret. Userinfo, query and fragment do not.
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
      // To end of line, not one token: the value is `<scheme> <credential>`, so a `\S+` here would consume the
      // scheme and leave the credential standing.
      .replace(/\b(Authorization\s*:\s*).*/gi, "$1<redacted>")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{1,4096}/gi, "$1 <redacted>")
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>")
      .replace(/\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}/g, "<redacted-jwt>")
      // Anchored on the base64 of `{"payload":"`, the stable AWS envelope prefix, rather than on generic
      // entropy, so a long base64 blob a build prints for its own reasons is not swept up with it.
      .replace(/\beyJwYXlsb2FkIjoi[A-Za-z0-9+/=_-]{64,8192}/g, "<redacted-ecr-token>")
      .replace(/\d{12}(?=\.dkr\.ecr\.)/g, "<redacted-aws-account>")
      // `ecs-` plus a long name run; the short public image `amazon-ecs-agent` does not match the 8-character
      // minimum and is left intact.
      .replace(/\becs-[a-z0-9-]{8,128}\b/g, "<redacted-ecs-name>")
      // The name survives — it is what tells a reader which internal value a diagnostic was about — the value
      // does not.
      .replace(
        /(?<![A-Za-z0-9])(SCVS_[A-Z0-9_]{1,64}\s*=\s*)("[^"]{0,4096}"|'[^']{0,4096}'|[^\s]{1,4096})/gi,
        "$1<redacted>",
      )
      // No `\b` in front: `_` is a word character, so `\b` would skip GITHUB_TOKEN and AWS_SESSION_TOKEN — the
      // names most likely to appear.
      .replace(
        /(?<![A-Za-z0-9])([A-Za-z0-9_-]{0,32}(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]{0,32}\s*[=:]\s*)("[^"]{0,4096}"|'[^']{0,4096}'|[^\s]{1,4096})/gi,
        "$1<redacted>",
      )
  );
}

/**
 * `MAX_REDACTED_INPUT`'s own comment says it is "well above `excerpt`'s limit, so nothing publishable is lost
 * to it".
 */
export function redactAll(value: string, maxInput: number = MAX_REDACTED_INPUT): string {
  const bounded = value.length > maxInput ? value.slice(0, maxInput) : value;
  return redactSecrets(redactLocalPath(bounded));
}

export function redactCommand(command: string[]): string[] {
  // `map` passes `(element, index, array)`, so the moment `redactAll` gained an optional second parameter the
  // index bound to it: argv[0] was sliced to 0 characters, argv[1] to 1, argv[2] to 2.
  return command.map((entry) => redactAll(entry));
}

export function summarizeGenericCommand(command: string[]): string {
  return redactCommand(command).join(" ");
}

/** Redact every string in an arbitrary record, in place of the caller remembering to. */
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

/** Trim captured output to something publishable, redacting on the way. */
export function excerpt(value: string, maxLength = 1_200): string | undefined {
  const normalized = redactAll(value).trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  const head = normalized.slice(0, Math.floor(maxLength / 2)).trimEnd();
  const tail = normalized.slice(-Math.floor(maxLength / 2)).trimStart();
  return `${head}\n... truncated ...\n${tail}`;
}
