const tokensByJobId = new Map<string, string>();

export function captureBuildLogToken(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const { job_id: jobId, build_log_token: token } = body as Record<string, unknown>;
  if (typeof jobId === "string" && typeof token === "string" && token.length > 0) {
    tokensByJobId.set(jobId, token);
  }
}

export function buildLogTokenFor(jobId: string): string | undefined {
  return tokensByJobId.get(jobId);
}
