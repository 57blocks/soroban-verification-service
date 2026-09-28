export type BulkCursor = { timestampMs: number; wasmHash: string };
export type BulkOrder = "asc" | "desc";

export const DEFAULT_BULK_ORDER: BulkOrder = "asc";
export const DEFAULT_BULK_LIMIT = 100;
export const MIN_BULK_LIMIT = 1;
export const MAX_BULK_LIMIT = 200;

export function parseBulkCursor(raw: string | undefined): BulkCursor | undefined {
  if (raw === undefined || raw === "") return undefined;
  const separator = raw.indexOf("-");
  if (separator <= 0) return undefined;

  const timestamp = raw.slice(0, separator);
  const wasmHash = raw.slice(separator + 1);
  if (!/^\d+$/.test(timestamp) || wasmHash === "") return undefined;

  const timestampMs = Number(timestamp);
  return Number.isSafeInteger(timestampMs) ? { timestampMs, wasmHash } : undefined;
}

export function formatBulkCursor(record: { updated_at: string; wasm_hash: string }): string {
  return `${new Date(record.updated_at).getTime()}-${record.wasm_hash}`;
}

export function parseBulkOrder(raw: string | undefined): BulkOrder | undefined {
  if (raw === undefined) return DEFAULT_BULK_ORDER;
  return raw === "asc" || raw === "desc" ? raw : undefined;
}

export function parseBulkLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_BULK_LIMIT;
  if (!/^\d+$/.test(raw)) return undefined;
  const limit = Number(raw);
  return limit >= MIN_BULK_LIMIT && limit <= MAX_BULK_LIMIT ? limit : undefined;
}
