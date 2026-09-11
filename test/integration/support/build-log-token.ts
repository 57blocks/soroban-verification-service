/**
 * The one-time `build_log_token` a submission's 202 carries (build-log-access BL-1).
 *
 * The service mints the token once, returns it in exactly that response, and stores only its digest —
 * there is no route that re-issues it, deliberately, because a route authorised by the job id would put
 * the model back where BL-1 found it. A harness that drops the token can therefore never read that job's
 * log again: `GET …/log` answers 401 without the header and 404 with a wrong one, so the loss shows up as
 * a failing assertion three steps away from the request that caused it.
 *
 * That is why the capture sits in `http()`, the single funnel every request goes through, and not in the
 * submit helpers: cases that post to the submit route directly (`dedup-04` does, five times) must not have
 * to remember this, and neither must the next one.
 *
 * The map is per Jest module registry, so it is per spec file — which is the right scope. A job's token
 * belongs to whoever created it, and a case that reads a log for a job another suite submitted has no
 * token by construction, exactly as a third party would not.
 */
const tokensByJobId = new Map<string, string>();

/** Records the pair when a body carries both. Silent on every other response — most bodies are not a 202. */
export function captureBuildLogToken(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const { job_id: jobId, build_log_token: token } = body as Record<string, unknown>;
  if (typeof jobId === "string" && typeof token === "string" && token.length > 0) {
    tokensByJobId.set(jobId, token);
  }
}

/**
 * `undefined` when this run never held the token — a 202 that attached to an in-flight job omits it, since
 * that job's log belongs to the submission that created it.
 */
export function buildLogTokenFor(jobId: string): string | undefined {
  return tokensByJobId.get(jobId);
}
