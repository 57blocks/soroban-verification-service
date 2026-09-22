import assert from "node:assert/strict";
import { startInterval, type IntervalRegistry } from "./interval-schedule.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
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
  await new Promise((resolve) => setTimeout(resolve, 15));
  clearInterval(registry.registered[0]![1]);
  assert.ok(calls > 0, "the tick should have run at least once");
});
