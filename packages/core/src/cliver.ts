export type ParsedCliver = {
  version: string;
  rev?: string;
};

/** Chain-recorded and interpolated into a URL path, so limited to tag-safe characters. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/** A 40-hex sha or a `git describe` string; nothing that could alter a URL or a shell word. */
const REV_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

export function parseCliver(recorded: string): ParsedCliver | undefined {
  const separator = recorded.indexOf("#");
  if (separator < 0) {
    return VERSION_RE.test(recorded) ? { version: recorded } : undefined;
  }

  const version = recorded.slice(0, separator);
  const rev = recorded.slice(separator + 1);
  if (!VERSION_RE.test(version) || !REV_RE.test(rev)) return undefined;
  return { version, rev };
}

export function sameCliBuild(a: string, b: string): boolean {
  const left = parseCliver(a);
  const right = parseCliver(b);
  if (!left?.rev || !right?.rev) return false;
  return left.version === right.version && left.rev === right.rev;
}
