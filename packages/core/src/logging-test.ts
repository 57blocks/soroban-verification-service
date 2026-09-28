import assert from "node:assert/strict";
import {
  ScvsLogger,
  currentLogContext,
  formatLogRecord,
  runWithLogContext,
  stderrOnlySink,
  type LogLevel,
} from "./logging.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

/** `test` does not await; async cases must use this. */
async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const clock = () => "2026-08-05T00:00:00.000Z";

function capture(): { lines: Array<{ level: LogLevel; line: string }>; sink: (level: LogLevel, line: string) => void } {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  return { lines, sink: (level, line) => lines.push({ level, line }) };
}

test("O1: every record is one JSON object carrying the component", () => {
  const { lines, sink } = capture();
  new ScvsLogger("build-dispatch", { clock, sink }).log("polling for queued jobs");

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].line), {
    ts: "2026-08-05T00:00:00.000Z",
    level: "info",
    component: "build-dispatch",
    msg: "polling for queued jobs",
  });
});

test("O1: `log` emits level `info`, and warn/error route to stderr", () => {
  const { lines, sink } = capture();
  const logger = new ScvsLogger("publish", { clock, sink });
  logger.log("a");
  logger.warn("b");
  logger.error("c");
  logger.debug("d");

  assert.deepEqual(
    lines.map((entry) => [entry.level, JSON.parse(entry.line).level]),
    [
      ["info", "info"],
      ["warn", "warn"],
      ["error", "error"],
      ["debug", "debug"],
    ],
  );
});

test("O2: `job_id` is inherited from the ambient scope, not passed by the call site", () => {
  const { lines, sink } = capture();
  const logger = new ScvsLogger("verification-pipeline", { clock, sink });

  runWithLogContext({ job_id: "job-1" }, () => {
    const inner = () => logger.log("dispatched to Batch");
    const middle = () => inner();
    middle();
  });

  assert.equal(JSON.parse(lines[0].line).job_id, "job-1");
});

test("O2: nested scopes merge, innermost wins, and the scope does not leak out", () => {
  const { lines, sink } = capture();
  const logger = new ScvsLogger("submit", { clock, sink });

  runWithLogContext({ request_id: "req-1" }, () => {
    runWithLogContext({ job_id: "job-1" }, () => {
      logger.log("job accepted");
    });
    logger.log("responding 202");
  });
  logger.log("outside any scope");

  const [both, outer, none] = lines.map((entry) => JSON.parse(entry.line));
  assert.deepEqual([both.request_id, both.job_id], ["req-1", "job-1"]);
  assert.deepEqual([outer.request_id, outer.job_id], ["req-1", undefined]);
  assert.deepEqual([none.request_id, none.job_id], [undefined, undefined]);
  assert.deepEqual(currentLogContext(), {});
});

await testAsync("O2: an async scope survives an await", async () => {
  const { lines, sink } = capture();
  const logger = new ScvsLogger("batch-events", { clock, sink });

  await runWithLogContext({ job_id: "job-async" }, async () => {
    await Promise.resolve();
    logger.log("terminal event consumed");
  });

  assert.equal(JSON.parse(lines[0].line).job_id, "job-async");
});

test("S18: a non-primitive field is dropped loudly, never spread into the record", () => {
  const { lines, sink } = capture();
  new ScvsLogger("batch-dispatch", { clock, sink }).log("submitting", {
    params: { upload_url: "https://s3.example/presigned?X-Amz-Signature=secret" } as never,
    job_id: "job-1",
  });

  const record = JSON.parse(lines[0].line);
  assert.deepEqual(record.dropped_fields, ["params"]);
  assert.equal(record.params, undefined);
  assert.equal(lines[0].line.includes("X-Amz-Signature"), false);
  assert.equal(record.job_id, "job-1");
});

test("S18: an Error becomes name and message, and carries no stack", () => {
  const { lines, sink } = capture();
  const error = new Error("ENOENT: /Users/someone/tmp/scvs-src-abc/Cargo.toml missing");
  new ScvsLogger("fetch-source", { clock, sink }).error("materialisation failed", { error });

  const record = JSON.parse(lines[0].line);
  assert.equal(record.error_name, "Error");
  assert.equal(record.error_message, "ENOENT: /Users/someone/tmp/scvs-src-abc/Cargo.toml missing");
  assert.equal(record.error, undefined);
  assert.equal("stack" in record, false);
  assert.equal(lines[0].line.includes("logging-test"), false);
});

test("a caller cannot forge a reserved key", () => {
  const { lines, sink } = capture();
  new ScvsLogger("preflight", { clock, sink }).warn("unsupported contract", {
    level: "info" as never,
    component: "something-else" as never,
    msg: "overwritten" as never,
  });

  const record = JSON.parse(lines[0].line);
  assert.equal(record.level, "warn");
  assert.equal(record.component, "preflight");
  assert.equal(record.msg, "unsupported contract");
  assert.deepEqual(record.dropped_reserved, ["component", "level", "msg"]);
});

test("an extra positional param from Nest's own logging is dropped, not forwarded", () => {
  const { lines, sink } = capture();
  const logger = new ScvsLogger("bootstrap", { clock, sink });
  (logger as { error(message: unknown, ...rest: unknown[]): void }).error(
    "Nest application failed",
    "Error: boom\n    at /app/services/query-svc/dist/main.js:12:9",
  );

  const record = JSON.parse(lines[0].line);
  assert.equal(record.msg, "Nest application failed");
  assert.equal(record.dropped_params, 1);
  assert.equal(lines[0].line.includes("/app/services"), false);
});

test("undefined fields are omitted rather than emitted as null", () => {
  const { lines, sink } = capture();
  new ScvsLogger("jobs", { clock, sink }).log("status read", { job_id: undefined, attempt: 2 });

  const record = JSON.parse(lines[0].line);
  assert.equal("job_id" in record, false);
  assert.equal(record.attempt, 2);
});

test("formatLogRecord orders keys ts, level, component, msg, ids, then the rest sorted", () => {
  const line = formatLogRecord(
    "info",
    "published",
    "publish",
    { zebra: 1, alpha: 2, request_id: "req-1", job_id: "job-1" },
    clock,
  );

  assert.deepEqual(Object.keys(JSON.parse(line)), [
    "ts",
    "level",
    "component",
    "msg",
    "job_id",
    "request_id",
    "alpha",
    "zebra",
  ]);
});

test("stderrOnlySink keeps every level off stdout, for a unit whose stdout is a protocol", () => {
  const written: Array<{ stream: string; chunk: string }> = [];
  const patch = (name: "stdout" | "stderr") => {
    const original = process[name].write.bind(process[name]);
    process[name].write = ((chunk: string) => {
      written.push({ stream: name, chunk: String(chunk) });
      return true;
    }) as typeof process.stdout.write;
    return () => {
      process[name].write = original;
    };
  };
  const restore = [patch("stdout"), patch("stderr")];
  try {
    const logger = new ScvsLogger("builder", { clock, sink: stderrOnlySink });
    logger.log("materialising source");
    logger.error("rebuild failed");
  } finally {
    for (const undo of restore) undo();
  }

  assert.deepEqual(
    written.map((entry) => entry.stream),
    ["stderr", "stderr"],
  );
  assert.equal(JSON.parse(written[0].chunk).component, "builder");
});

test("a blank component is named `unknown` rather than omitted (O1)", () => {
  assert.equal(JSON.parse(formatLogRecord("info", "orphan", "", {}, clock)).component, "unknown");
  assert.equal(JSON.parse(formatLogRecord("info", "orphan", "  ", {}, clock)).component, "unknown");
});

console.log("Logging kernel: 13 cases passed");
