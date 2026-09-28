// Its own key, not `scvs:recentJobs`: that list is capped at eight and would drop tokens.
const TOKENS_KEY = "scvs:buildLogTokens";

/** Past the server's 7-day log retention, so an older entry can only be dead. */
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

export const rememberBuildLogToken = (jobId: string, token: string | undefined) => {
  if (typeof window === "undefined" || !token) return;
  try {
    const next = prune(readAll(), Date.now());
    next[jobId] = { token, stored_at: new Date().toISOString() };
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: this reader loses only the raw log.
  }
};

export const readBuildLogToken = (jobId: string | null): string | undefined =>
  jobId ? readAll()[jobId]?.token : undefined;

export const forgetBuildLogToken = (jobId: string) => {
  if (typeof window === "undefined") return;
  try {
    const next = prune(readAll(), Date.now());
    delete next[jobId];
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(next));
  } catch {
    // Best effort: nothing depends on this succeeding.
  }
};
