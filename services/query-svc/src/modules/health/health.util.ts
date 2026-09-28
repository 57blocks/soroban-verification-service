export function healthPayload(version: string): { status: string; version: string } {
  return { status: "ok", version };
}
