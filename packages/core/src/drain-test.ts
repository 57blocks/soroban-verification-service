import assert from "node:assert/strict";
import { DrainState, readiness } from "./drain.js";
import { ScvsLogger, type LogLevel } from "./logging.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const NOW = "2026-08-05T12:00:00.000Z";
const LATER = "2026-08-05T12:00:05.000Z";

test("a fresh process is not draining", () => {
  const drain = new DrainState();
  assert.equal(drain.isDraining, false);
  assert.equal(drain.since, undefined);
});

test("beginDrain is idempotent — SIGTERM can arrive twice", () => {
  const drain = new DrainState();
  assert.equal(drain.beginDrain(NOW), true);
  assert.equal(drain.beginDrain(LATER), false);
  assert.equal(drain.since, NOW);
});

test("beginDrain logs once, and only on the transition", () => {
  const lines: string[] = [];
  const logger = new ScvsLogger("drain", {
    clock: () => NOW,
    sink: (_level: LogLevel, line: string) => lines.push(line),
  });
  const drain = new DrainState();
  drain.beginDrain(NOW, logger);
  drain.beginDrain(LATER, logger);

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, "warn");
  assert.equal(record.draining_since, NOW);
  assert.match(String(record.msg), /Status reads stay served/);
});

test("readiness is true when nothing is draining and every check passes", () => {
  const report = readiness(new DrainState(), { database: { ok: true } });
  assert.deepEqual(report, { ready: true, draining: false, checks: { database: { ok: true } } });
});

test("a failed check makes it not ready, and says which", () => {
  const report = readiness(new DrainState(), {
    database: { ok: false, detail: "connect ECONNREFUSED" },
    storage: { ok: true },
  });
  assert.equal(report.ready, false);
  assert.equal(report.checks.database.detail, "connect ECONNREFUSED");
});

test("draining wins over healthy checks — live, but must not receive new work", () => {
  const drain = new DrainState();
  drain.beginDrain(NOW);
  const report = readiness(drain, { database: { ok: true } });

  assert.equal(report.ready, false);
  assert.equal(report.draining, true);
  assert.equal(report.draining_since, NOW);
  assert.equal(report.checks.database.ok, true);
});

test("draining_since is absent, not null, when not draining", () => {
  const report = readiness(new DrainState(), {});
  assert.equal("draining_since" in report, false);
});

test("a service with no probed dependencies reports an empty check set, not a fake pass", () => {
  const report = readiness(new DrainState(), {});
  assert.deepEqual(report.checks, {});
  assert.equal(report.ready, true);
});

console.log("Drain state: 8 cases passed");
