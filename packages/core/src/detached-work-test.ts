import assert from "node:assert/strict";
import { DetachedWork } from "./detached-work.js";
import { ScvsLogger, type LogLevel } from "./logging.js";

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function capturingLogger(): { logger: ScvsLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = new ScvsLogger("detached-work-test", { sink: (_level: LogLevel, line: string) => lines.push(line) });
  return { logger, lines };
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

await test("work runs as soon as it is started, as a bare `void work()` would", async () => {
  const work = new DetachedWork(capturingLogger().logger);
  let called = false;
  work.start(async () => {
    called = true;
  });
  assert.equal(called, true);
  await work.drain();
});

await test("drain waits for work that is still running", async () => {
  const work = new DetachedWork(capturingLogger().logger);
  const held = gate();
  let finished = false;
  work.start(async () => {
    await held.opened;
    finished = true;
  });

  let drained = false;
  const draining = work.drain().then(() => (drained = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "drain resolved while the work was still held");

  held.open();
  await draining;
  assert.equal(finished, true);
});

await test("work started once draining has begun is refused", async () => {
  const work = new DetachedWork(capturingLogger().logger);
  const held = gate();
  work.start(() => held.opened);
  const draining = work.drain();

  let called = false;
  work.start(async () => {
    called = true;
  });
  held.open();
  await draining;
  assert.equal(called, false);
});

await test("a rejection is logged instead of left unhandled, and drain still resolves", async () => {
  const { logger, lines } = capturingLogger();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const work = new DetachedWork(logger);
    work.start(() => Promise.reject(new Error("the work blew up")));
    await work.drain();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /detached work rejected/);
  assert.match(lines[0]!, /the work blew up/);
});
