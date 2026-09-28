import type { ScvsLogger, ScvsMetrics } from "@scvs/core";
import type { StatusLinkOutcome } from "@scvs/db";
import type { WasmStatusWriteResult } from "@scvs/storage-layout";

export type StatusLinkContext = {
  jobId: string;
  wasmHash: string;
  link: string;
  logger: ScvsLogger;
  metrics: ScvsMetrics;
};

export function toStatusLinkOutcome(
  result: WasmStatusWriteResult,
  context: StatusLinkContext,
): StatusLinkOutcome {
  const dimensions = { link: context.link, result };
  switch (result) {
    case "written":
      return { state: "complete", advancePublished: true };
    case "already-present":
      // On a retry the object write may have landed before the row update, so consumers have not seen the link.
      return { state: "complete", advancePublished: true };
    case "superseded":
      context.metrics.counter("status_link_unwritten_total", 1, dimensions);
      return { state: "complete", advancePublished: false };
    case "absent":
    case "conflict":
      context.metrics.counter("status_link_unwritten_total", 1, dimensions);
      context.logger.warn("status-document link not written; the job still owes it", {
        job_id: context.jobId,
        wasm_hash: context.wasmHash,
        link: context.link,
        result,
      });
      return { state: "pending" };
    case "invalid-document":
    case "unrepresentable":
      context.metrics.counter("status_link_unwritten_total", 1, dimensions);
      context.logger.error("status-document link cannot be written; holding the job for a human", {
        job_id: context.jobId,
        wasm_hash: context.wasmHash,
        link: context.link,
        result,
      });
      return { state: "blocked", reason: result === "invalid-document" ? "invalid_document" : "unrepresentable" };
  }
}

export function combineStatusLinkOutcomes(outcomes: readonly StatusLinkOutcome[]): StatusLinkOutcome {
  const blocked = outcomes.find((outcome) => outcome.state === "blocked");
  if (blocked) return blocked;
  if (outcomes.some((outcome) => outcome.state === "pending")) return { state: "pending" };
  return { state: "complete", advancePublished: outcomes.some((o) => o.state === "complete" && o.advancePublished) };
}
