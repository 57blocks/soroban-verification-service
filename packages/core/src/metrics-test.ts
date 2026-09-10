import assert from "node:assert/strict";
import { ScvsLogger, runWithLogContext, type LogLevel } from "./logging.js";
import { METRIC_FIELD, METRIC_UNITS, ScvsMetrics } from "./metrics.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const clock = () => "2026-08-05T00:00:00.000Z";

function capture(component = "build-dispatch"): {
  records: Array<Record<string, unknown>>;
  metrics: ScvsMetrics;
  logger: ScvsLogger;
} {
  const records: Array<Record<string, unknown>> = [];
  const sink = (_level: LogLevel, line: string) => records.push(JSON.parse(line));
  const logger = new ScvsLogger(component, { clock, sink });
  return { records, metrics: new ScvsMetrics(component, { logger }), logger };
}

test("O4: a gauge is one record carrying metric, value and unit", () => {
  const { records, metrics } = capture();
  metrics.gauge("queue_depth", 7);

  // This exact shape is what an O5 metric filter selects and extracts.
  assert.deepEqual(records[0], {
    ts: "2026-08-05T00:00:00.000Z",
    level: "info",
    component: "build-dispatch",
    msg: "metric",
    metric: "queue_depth",
    metric_type: "gauge",
    unit: "count",
    value: 7,
  });
});

test("O4: `metric` is the field name alarms select on", () => {
  assert.equal(METRIC_FIELD, "metric");
  const { records, metrics } = capture();
  metrics.counter("verdict_total", 1, { verdict: "verified" });
  assert.equal(records[0][METRIC_FIELD], "verdict_total");
});

test("O4: job duration carries BOTH path and outcome, which is what makes it answer anything", () => {
  const { records, metrics } = capture("publish");
  metrics.histogram("job_duration_seconds", 42.5, { path: "cli", outcome: "verified" });

  assert.deepEqual(records[0], {
    ts: "2026-08-05T00:00:00.000Z",
    level: "info",
    component: "publish",
    msg: "metric",
    metric: "job_duration_seconds",
    metric_type: "histogram",
    unit: "seconds",
    value: 42.5,
    outcome: "verified",
    path: "cli",
  });
});

test("a metric record inherits the ambient job_id, with no call site passing one", () => {
  const { records, metrics } = capture("verification-pipeline");

  // The property the CloudWatch SDK path would not have given us for free: the worker's poll loop entered this
  // scope, and a metric emitted anywhere beneath it is attributable to the job.
  runWithLogContext({ job_id: "job-1" }, () => {
    metrics.counter("failure_reason_total", 1, { reason: "build_timeout" });
  });

  assert.equal(records[0].job_id, "job-1");
  assert.equal(records[0].reason, "build_timeout");
  assert.equal(records[0].metric, "failure_reason_total");
});

test("every unit in METRIC_UNITS is count or seconds, and the name is the key", () => {
  for (const [name, unit] of Object.entries(METRIC_UNITS)) {
    assert.ok(unit === "count" || unit === "seconds", `${name} has unit ${unit}`);
  }
  assert.equal(Object.keys(METRIC_UNITS).length, 14);
});

test("a dimension cannot shadow `value` and silently redirect the filter", () => {
  const { records, metrics } = capture();
  metrics.gauge("queue_depth", 3, { value: "99", metric: "something_else", unit: "bogus" });

  assert.equal(records[0].value, 3);
  assert.equal(records[0].metric, "queue_depth");
  assert.equal(records[0].unit, "count");
});

test("a non-finite value is dropped with a warning, never emitted", () => {
  const { records, metrics } = capture();
  // How this happens for real: a duration computed from a timestamp that failed to parse.
  metrics.histogram("job_duration_seconds", Number.NaN, { path: "cli", outcome: "verified" });
  metrics.gauge("queue_depth", Number.POSITIVE_INFINITY);

  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.level, "warn");
    assert.equal(record.msg, "metric dropped: value is not finite");
    assert.equal(record.value, undefined);
    assert.equal(record.metric, undefined); // must not look like a metric record to a filter
  }
});

test("counter defaults to 1", () => {
  const { records, metrics } = capture();
  metrics.counter("verdict_total");
  assert.equal(records[0].value, 1);
});

test("archive_backlog is a real gauge, sourced from a durable count — not announced as unavailable", () => {
  // `archive_backlog` is now just another gauge; `ArchiveRecoveryScheduler` is what sources its value, from
  // `JobsRepository.listJobsPendingArchive`.
  const { records, metrics } = capture("archive-recovery");
  metrics.gauge("archive_backlog", 3);

  assert.deepEqual(records[0], {
    ts: "2026-08-05T00:00:00.000Z",
    level: "info",
    component: "archive-recovery",
    msg: "metric",
    metric: "archive_backlog",
    metric_type: "gauge",
    unit: "count",
    value: 3,
  });
});

console.log("Metrics emitter: 9 cases passed");
