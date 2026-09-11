import { readFile } from "node:fs/promises";
import { parseDto } from "@scvs/core";

/** `class-transformer`'s `ClassConstructor`, restated so the sandbox image needs no direct dependency on it. */
type JobParamsClass<T> = new (...args: any[]) => T;

/** Reading the job's own parameters — the one thing **both** halves of the split builder need. */
export async function readJobParams<T extends object>(
  params: JobParamsClass<T>,
  jobParamsJson: string | undefined,
): Promise<T> {
  const raw = await readJobParamsRaw(jobParamsJson);
  return parseDto(params, JSON.parse(raw));
}

/**
 * Both entrypoints call this rather than reading one variable directly, so the priority lives in exactly one
 * place.
 */
export function jobParamsInput(
  url: string | undefined,
  json: string | undefined,
): string | undefined {
  return url && url.trim() ? url : json;
}

/**
 * Upper bound on the params blob. The real documents are 2–5 KB; the bound exists so a mis-pointed URL (say,
 * the source tarball's) fails loudly instead of buffering arbitrarily.
 */
const MAX_PARAMS_BLOB_BYTES = 64 * 1024;

/** The params fetch happens before the job can report anything, so a hung fetch must time out. */
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

/** Bounded GET of the staged params document. */
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
