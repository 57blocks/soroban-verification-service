/** Shared by `/health` and `/api/query/v1/health` so the two bodies cannot drift apart. */
export function healthPayload(version: string): { status: string; version: string } {
  return { status: "ok", version };
}
