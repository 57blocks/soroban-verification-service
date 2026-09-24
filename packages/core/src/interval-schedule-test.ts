import assert from "node:assert/strict";
import { DetachedWork } from "./detached-work.js";
import { startInterval, type IntervalRegistry } from "./interval-schedule.js";
import { ScvsLogger } from "./logging.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

/** Waits for a condition instead of a duration: a loaded runner is slow, not broken. */
async function until(condition: () => boolean, what: string, deadlineMs = 2_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeRegistry(): IntervalRegistry & { readonly registered: Array<[string, NodeJS.Timeout]> } {
  const registered: Array<[string, NodeJS.Timeout]> = [];
  return {
    registered,
    addInterval(name, ref) {
      registered.push([name, ref]);
    },
  };
}

test("the registry owns the handle, under the name given", () => {
  const registry = fakeRegistry();
  startInterval(registry, "job-retry", 60_000, () => undefined);
  assert.equal(registry.registered.length, 1);
  assert.equal(registry.registered[0]?.[0], "job-retry");
  clearInterval(registry.registered[0]![1]);
});

// `Number(process.env.X || default)` answered `NaN` for a non-numeric value, and `@Interval(NaN)` fires on
// every tick of the event loop. Startup is the only place that can still be refused.
test("a non-positive or unparsable interval fails at startup, naming the scheduler", () => {
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    const registry = fakeRegistry();
    assert.throws(
      () => startInterval(registry, "job-retry", bad, () => undefined),
      /job-retry needs a positive interval/,
      `${String(bad)} must be refused`,
    );
    assert.equal(registry.registered.length, 0, `${String(bad)} must not reach the registry`);
  }
});

test("the tick runs on the interval", async () => {
  const registry = fakeRegistry();
  let calls = 0;
  startInterval(registry, "build-dispatch", 1, () => {
    calls += 1;
    return Promise.resolve();
  });
  await until(() => calls > 0, "the first tick");
  clearInterval(registry.registered[0]![1]);
});

// Node turns an unhandled rejection into a fatal error. A sweep that throws must cost its own tick, not the
// process — and a test harness that builds the app must not be killed by one after its last assertion.
test("a rejecting tick is caught, and the schedule survives it", async () => {
  const registry = fakeRegistry();
  let calls = 0;
  startInterval(registry, "job-retry", 1, () => {
    calls += 1;
    return Promise.reject(new Error("the tick blew up"));
  });
  // Waited for, not slept through: a 1 ms interval is not guaranteed two ticks inside a fixed 20 ms window
  // on a loaded runner, which is how this failed in CI while passing everywhere else.
  await until(() => calls > 1, "a second tick after the first one rejected");
  clearInterval(registry.registered[0]![1]);
});

// The service's HTTP listener keeps the process alive. A sweep timer that also did would hold a finished
// test runner open — which is exactly what reached CI.
test("the handle does not hold the process open", () => {
  const registry = fakeRegistry();
  startInterval(registry, "upload-cleanup", 60_000, () => undefined);
  const ref = registry.registered[0]![1] as NodeJS.Timeout & { hasRef(): boolean };
  assert.equal(ref.hasRef(), false);
  clearInterval(ref);
});

// A module's shutdown closes the database next, so a tick still running at that point would query a closed pool.
test("draining the work waits for the tick in flight, and no tick starts after it", async () => {
  const registry = fakeRegistry();
  const work = new DetachedWork(new ScvsLogger("archive-recovery"));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  let finished = 0;
  startInterval(
    registry,
    "archive-recovery",
    1,
    async () => {
      started += 1;
      await held;
      finished += 1;
    },
    work,
  );
  await until(() => started > 0, "the first tick");

  let drained = false;
  const draining = work.drain().then(() => (drained = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false, "drain resolved while a tick was still running");
  const startedBeforeRelease = started;

  release();
  await draining;
  assert.equal(finished, started);
  // Twenty 1 ms periods: every one of them must have been refused.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, startedBeforeRelease);
  clearInterval(registry.registered[0]![1]);
});
