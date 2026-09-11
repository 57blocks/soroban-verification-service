/**
 * The one-time tokens that read raw build logs (build-log-access design.md BL-1), kept per browser.
 *
 * **Its own key, not `scvs:recentJobs`.** That list is capped at eight entries, so a token stored in it
 * would disappear on the ninth submission and the log would stop being readable for a reason the reader
 * cannot see. This map is uncapped and pruned only by age, because the tokens it holds are worthless once
 * their logs expire anyway.
 *
 * The consequence, which is the intended behaviour and not a bug: **a shared job link carries no token**,
 * so a visitor sees the diagnostic summary and not the raw log.
 */
const TOKENS_KEY = "scvs:buildLogTokens";

/** Comfortably past the server's 7-day log retention; an entry older than this can only be dead. */
const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60_000;

type StoredToken = { token: string; stored_at: string };
type TokenMap = Record<string, StoredToken>;

const readAll = (): TokenMap => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TOKENS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TokenMap;
  } catch {
    return {};
  }
};

const prune = (tokens: TokenMap, now: number): TokenMap =>
  Object.fromEntries(
    Object.entries(tokens).filter(
      ([, entry]) =>
        typeof entry?.token === "string" &&
        now - (Date.parse(entry.stored_at) || 0) < MAX_TOKEN_AGE_MS,
    ),
  );

/** Stores the token a submission returned. Called once per created job; never for a reused one. */
export const rememberBuildLogToken = (jobId: string, token: string | undefined) => {
  if (typeof window === "undefined" || !token) return;
  try {
    const next = prune(readAll(), Date.now());
    next[jobId] = { token, stored_at: new Date().toISOString() };
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(next));
  } catch {
    // A browser refusing storage costs this reader the raw log and nothing else.
  }
};

export const readBuildLogToken = (jobId: string | null): string | undefined =>
  jobId ? readAll()[jobId]?.token : undefined;

/** After the token holder deletes the log, or the server says it is gone. */
export const forgetBuildLogToken = (jobId: string) => {
  if (typeof window === "undefined") return;
  try {
    const next = prune(readAll(), Date.now());
    delete next[jobId];
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(next));
  } catch {
    // Same as above: nothing else depends on this succeeding.
  }
};
