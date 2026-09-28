import type { RebuildErrorCode } from "@scvs/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MaterializedSource } from "./fetch-source.js";

export type SourceHandoff =
  | { ok: true; schema: typeof HANDOFF_SCHEMA; job_id: string; source: MaterializedSource }
  | {
      ok: false;
      schema: typeof HANDOFF_SCHEMA;
      job_id: string;
      reason: RebuildErrorCode;
      status: string;
      detail: string;
    };

export const HANDOFF_SCHEMA = "scvs-source-handoff-v1" as const;

export function handoffPath(root: string, jobId: string): string {
  return join(root, "scvs-handoff", jobId, "source.json");
}

export async function writeHandoff(path: string, handoff: SourceHandoff): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
}

export async function readHandoff(path: string): Promise<SourceHandoff> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as SourceHandoff;
  if (parsed?.schema !== HANDOFF_SCHEMA) {
    throw new Error(
      `source handoff at ${path} has schema ${String(parsed?.schema)}, expected ${HANDOFF_SCHEMA}`,
    );
  }
  return parsed;
}
