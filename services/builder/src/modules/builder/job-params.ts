import { readFile } from "node:fs/promises";
import { parseDto } from "@scvs/core";

type JobParamsClass<T> = new (...args: any[]) => T;

export async function readJobParams<T extends object>(
  params: JobParamsClass<T>,
  jobParamsJson: string | undefined,
): Promise<T> {
  const raw = await readJobParamsRaw(jobParamsJson);
  return parseDto(params, JSON.parse(raw));
}

export function jobParamsInput(
  url: string | undefined,
  json: string | undefined,
): string | undefined {
  return url && url.trim() ? url : json;
}

const MAX_PARAMS_BLOB_BYTES = 64 * 1024;

const PARAMS_FETCH_TIMEOUT_MS = 30_000;

async function readJobParamsRaw(jobParamsJson: string | undefined): Promise<string> {
  const inline = jobParamsJson?.trim();
  if (inline) {
    return inline.startsWith("https://") ? fetchParamsBlob(inline) : jobParamsJson!;
  }
  const argPath = process.argv[2];
  if (argPath) return readFile(argPath, "utf8");
  return readStdin();
}

async function fetchParamsBlob(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(PARAMS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`job params fetch failed: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new Error("job params fetch returned no body");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_PARAMS_BLOB_BYTES) {
      await reader.cancel();
      throw new Error(`job params blob exceeds ${MAX_PARAMS_BLOB_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
