import type { ScvsLogger, ScvsMetrics } from "@scvs/core";
import type { StatusLinkOutcome } from "@scvs/db";
import type { WasmStatusWriteResult } from "@scvs/storage-layout";

export type StatusLinkContext = {
  jobId: string;
  wasmHash: string;
  /** Which link this was, for the metric dimension — e.g. `report archive`, `source uri`. */
  link: string;
  logger: ScvsLogger;
  metrics: ScvsMetrics;
};

/**
 * The one place a status-document result becomes a durable obligation. Only `conflict` and `absent` are
 * worth another pass; the two that another pass cannot fix hold the job for a human rather than spinning
 * the scan against a document that will never read.
 */
export function toStatusLinkOutcome(
  result: WasmStatusWriteResult,
  context: StatusLinkContext,
): StatusLinkOutcome {
  const dimensions = { link: context.link, result };
  switch (result) {
    case "written":
      return { state: "complete", advancePublished: true };
    case "already-present":
      // On a retry this means the object write landed and the process died before the row update, so a
      // consumer that synced in between has not seen the link.
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

/**
 * One row carries one obligation, so several links collapse to a single outcome. Blocked wins over pending
 * and pending over complete: the row may only say "nothing is owed" when nothing is.
 *
 * No links at all is `complete` — the obligation was recorded for a job whose row no longer names any link,
 * and leaving it pending would spin the scan against nothing to do.
 */
export function combineStatusLinkOutcomes(outcomes: readonly StatusLinkOutcome[]): StatusLinkOutcome {
  const blocked = outcomes.find((outcome) => outcome.state === "blocked");
  if (blocked) return blocked;
  if (outcomes.some((outcome) => outcome.state === "pending")) return { state: "pending" };
  // Every link is in the document. Advancing is the safe direction wherever any of them changed it.
  return { state: "complete", advancePublished: outcomes.some((o) => o.state === "complete" && o.advancePublished) };
}
