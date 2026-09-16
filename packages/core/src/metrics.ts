import { ScvsLogger, type LogFields } from "./logging.js";

/**
 * **The record shape is the contract, not an implementation detail.** O5's alarms are metric filters, and a
 * filter selects on `metric` and extracts `value`:
 */

/**
 * `unit` travels with the name because a filter cannot infer it and an operator reading a bare number cannot
 * either.
 */
export const METRIC_UNITS = {
  /** Non-terminal jobs waiting for a worker slice. Answers "is the backlog why submissions look slow?" */
  queue_depth: "count",
  /** Jobs currently held by a worker. The other half of the queue-depth question. */
  jobs_in_flight: "count",
  /** Accept-to-terminal wall clock, dimensioned by `path` and `outcome` — both, or it answers nothing. */
  job_duration_seconds: "seconds",
  /** `verified` vs `mismatched`. */
  verdict_total: "count",
  /** Which failure class dominates. A spike in one reason localises the defect. */
  failure_reason_total: "count",
  /**
   * Published results still unarchived. Sourced from `jobs.archive_pending_since` (AP4) via
   * `JobsRepository.listJobsPendingArchive`.
   */
  archive_backlog: "count",
  source_publish_backlog: "count",
  /** Mainnet+public jobs whose source has not yet been archived to Arweave. */
  source_archive_backlog: "count",
  /**
   * Unpublished job records past their retention period and not yet deleted. A level that stays high is the
   * retention sweep failing to keep up, which nothing else reports (retention-and-pseudonymisation RP-3).
   */
  retention_backlog: "count",
  /** Raw build logs past their 7-day retention and not yet deleted (build-log-access BL-2). */
  build_log_expiry_backlog: "count",
  /** Per-verifier fetch latency in the query layer, dimensioned by `verifier`. */
  verifier_aggregation_seconds: "seconds",
  /** Per-verifier fetch outcome, dimensioned by `verifier` and `outcome`. */
  verifier_aggregation_total: "count",
  /**
   * Build-environment compositions, dimensioned by `outcome` (`dispatched`, `dispatch_failed`, `success`,
   * `composition_failure`, `timed_out`) and `template_version`.
   */
  environment_composition_total: "count",
  /** Wall-clock for one composition, dispatch to terminal, dimensioned the same way. */
  environment_composition_seconds: "seconds",
  /**
   * Attempts to put a link into `wasms/<hash>.json` that did not land, dimensioned by `link` and `result`.
   * An upload that is paid for and never referenced is invisible without this.
   */
  status_link_unwritten_total: "count",
  /** Jobs still owing a status-document link, from `listJobsPendingStatusLink`. */
  status_link_backlog: "count",
  /** Jobs held for a human because their link cannot be written, dimensioned by `reason`. */
  status_link_blocked: "count",
  /**
   * Age of the oldest outstanding link obligation. The backlog level alone cannot distinguish a queue that
   * is moving from one job that has been stuck since the day it published.
   */
  status_link_oldest_pending_seconds: "seconds",
} as const satisfies Record<string, "count" | "seconds">;

export type MetricName = keyof typeof METRIC_UNITS;

/** `gauge` is a level now, `counter` is an increment, `histogram` is one observation of a distribution. */
export type MetricType = "gauge" | "counter" | "histogram";

/** Dimension values are strings so they can be a metric filter's dimension without further parsing. */
export type MetricDimensions = Record<string, string>;

/** The field name a metric filter's pattern selects on. Changing it invalidates every alarm. */
export const METRIC_FIELD = "metric";

/**
 * Emits O4's metrics through the same logger everything else uses, so a metric record inherits the ambient log
 * scope.
 */
export class ScvsMetrics {
  private readonly logger: ScvsLogger;

  constructor(component: string, options: { logger?: ScvsLogger } = {}) {
    this.logger = options.logger ?? new ScvsLogger(component);
  }

  /** A level: queue depth, in-flight count, backlog size. */
  gauge(name: MetricName, value: number, dimensions?: MetricDimensions): void {
    this.emit("gauge", name, value, dimensions);
  }

  /** An increment. Defaults to 1, because that is what every call site so far wants. */
  counter(name: MetricName, increment = 1, dimensions?: MetricDimensions): void {
    this.emit("counter", name, increment, dimensions);
  }

  /** One observation of a distribution — a duration, a size. */
  histogram(name: MetricName, value: number, dimensions?: MetricDimensions): void {
    this.emit("histogram", name, value, dimensions);
  }

  /** A non-finite value is dropped rather than emitted. */
  private emit(
    type: MetricType,
    name: MetricName,
    value: number,
    dimensions?: MetricDimensions,
  ): void {
    if (!Number.isFinite(value)) {
      this.logger.warn("metric dropped: value is not finite", { metric_name: name, metric_type: type });
      return;
    }

    const fields: LogFields = {
      [METRIC_FIELD]: name,
      metric_type: type,
      unit: METRIC_UNITS[name],
      value,
    };
    // Dimensions cannot shadow the record's own metric fields: a dimension called `value` would make the filter
    // extract the wrong number, silently, and only under the input that produced it.
    for (const [key, dimension] of Object.entries(dimensions ?? {})) {
      if (key in fields) continue;
      fields[key] = dimension;
    }

    // `msg` is a constant so a filter can select records by shape as well as by metric name.
    this.logger.log("metric", fields);
  }
}
