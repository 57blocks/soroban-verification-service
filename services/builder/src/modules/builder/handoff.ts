import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MaterializedSource } from "./fetch-source.js";

/**
 * A file rather than a return value because they are separate containers in one Batch job: the materialiser
 * holds no container-execution capability and does the fetching and extracting.
 */
export type SourceHandoff =
  | { ok: true; schema: typeof HANDOFF_SCHEMA; job_id: string; source: MaterializedSource }
  | {
      ok: false;
      schema: typeof HANDOFF_SCHEMA;
      job_id: string;
      /** Machine-readable, and passed straight through to the `cli_failure` the runner emits. */
      reason: string;
      status: string;
      detail: string;
    };

export const HANDOFF_SCHEMA = "scvs-source-handoff-v1" as const;

/** Per job, under the shared mount. */
export function handoffPath(root: string, jobId: string): string {
  return join(root, "scvs-handoff", jobId, "source.json");
}

export async function writeHandoff(path: string, handoff: SourceHandoff): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
}

/**
 * Throws when the document is missing or unreadable, which is the runner's cue that the materialiser did not
 * run at all.
 */
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
