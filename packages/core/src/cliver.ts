// Splitting the `cliver` a cli-legacy contract records into the two different things it carries.

/** A recorded `cliver`, split into the two things it actually carries. */
export type ParsedCliver = {
  /**
   * The stellar-cli release version — the part before `#`. This, never the whole recorded string, is what names
   * a release tag.
   */
  version: string;
  /**
   * The build identity after `#`: a 40-hex commit sha for a build made from a tagged checkout, or a `git
   * describe` string (`v20.0.0-833-g…`) for one made between tags.
   */
  rev?: string;
};

/**
 * The version half must be usable as a release tag. Chain-derived means immutable, not well-formed — a contract
 * can record anything, and this value is interpolated into a URL path.
 */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * Covers both observed rev shapes — a 40-hex sha and a `git describe` string — and nothing that could change
 * the meaning of a URL or a shell word.
 */
const REV_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

/** Splits a recorded `cliver`, or `undefined` when it is not a shape we understand. */
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

/** Whether two recorded `cliver` strings name the **same stellar-cli build**. */
export function sameCliBuild(a: string, b: string): boolean {
  const left = parseCliver(a);
  const right = parseCliver(b);
  if (!left?.rev || !right?.rev) return false;
  return left.version === right.version && left.rev === right.rev;
}
