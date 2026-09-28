import { ScvsLogger, type LogFields } from "./logging.js";

export const METRIC_UNITS = {
  queue_depth: "count",
  jobs_in_flight: "count",
  job_duration_seconds: "seconds",
  verdict_total: "count",
  failure_reason_total: "count",
  archive_backlog: "count",
  source_publish_backlog: "count",
  source_archive_backlog: "count",
  retention_backlog: "count",
  build_log_expiry_backlog: "count",
  verifier_aggregation_seconds: "seconds",
  verifier_aggregation_total: "count",
  environment_composition_total: "count",
  environment_composition_seconds: "seconds",
  status_link_unwritten_total: "count",
  status_link_backlog: "count",
  status_link_blocked: "count",
  status_link_oldest_pending_seconds: "seconds",
} as const satisfies Record<string, "count" | "seconds">;

export type MetricName = keyof typeof METRIC_UNITS;

export type MetricType = "gauge" | "counter" | "histogram";

export type MetricDimensions = Record<string, string>;

/** Metric filters select on this field; renaming it breaks every alarm. */
export const METRIC_FIELD = "metric";

export class ScvsMetrics {
  private readonly logger: ScvsLogger;

  constructor(component: string, options: { logger?: ScvsLogger } = {}) {
    this.logger = options.logger ?? new ScvsLogger(component);
  }

  gauge(name: MetricName, value: number, dimensions?: MetricDimensions): void {
    this.emit("gauge", name, value, dimensions);
  }

  counter(name: MetricName, increment = 1, dimensions?: MetricDimensions): void {
    this.emit("counter", name, increment, dimensions);
  }

  histogram(name: MetricName, value: number, dimensions?: MetricDimensions): void {
    this.emit("histogram", name, value, dimensions);
  }

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
    // A dimension must not shadow a record field, or the filter extracts the wrong value.
    for (const [key, dimension] of Object.entries(dimensions ?? {})) {
      if (key in fields) continue;
      fields[key] = dimension;
    }

    this.logger.log("metric", fields);
  }
}
