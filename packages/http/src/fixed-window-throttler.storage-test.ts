import assert from "node:assert/strict";
import { FixedWindowThrottlerStorage } from "./fixed-window-throttler.storage.js";

const NAME = "default";
const TTL = 200;
const BLOCK = 100;
const LIMIT = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let storage: FixedWindowThrottlerStorage;

const hit = (key: string) => storage.increment(key, TTL, LIMIT, BLOCK, NAME);

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  storage = new FixedWindowThrottlerStorage();
  await fn();
  console.log(`ok - ${name}`);
}

await test("does not inherit a neighbour's count when that neighbour leaves the blocked state", async () => {
  for (let i = 0; i < LIMIT + 1; i += 1) await hit("attacker");
  assert.equal((await hit("attacker")).isBlocked, true);

  await sleep(BLOCK + 20);
  await hit("bystander");
  await hit("bystander");

  await hit("attacker");

  await sleep(TTL * 2 + 20);

  const verdicts: boolean[] = [];
  for (let i = 0; i < LIMIT; i += 1) verdicts.push((await hit("bystander")).isBlocked);
  assert.deepEqual(verdicts, [false, false, false]);
});

await test("survives the attacker cycling in and out of the block repeatedly", async () => {
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (let i = 0; i < LIMIT + 1; i += 1) await hit("attacker");
    await hit("bystander");
    await sleep(BLOCK + 20);
    await hit("attacker");
  }

  await sleep(TTL * 2 + 20);
  assert.equal((await hit("bystander")).totalHits, 1);
});

await test("admits exactly the limit and refuses the next request", async () => {
  const verdicts: boolean[] = [];
  for (let i = 0; i < LIMIT + 1; i += 1) verdicts.push((await hit("caller")).isBlocked);
  assert.deepEqual(verdicts, [false, false, false, true]);
});

await test("starts a fresh window once the old one has passed", async () => {
  for (let i = 0; i < LIMIT; i += 1) await hit("caller");
  await sleep(TTL + 20);

  const record = await hit("caller");
  assert.equal(record.totalHits, 1);
  assert.equal(record.isBlocked, false);
});

await test("does not let a blocked caller extend its own penalty by knocking", async () => {
  for (let i = 0; i < LIMIT + 1; i += 1) await hit("caller");
  const blocked = await hit("caller");
  assert.equal(blocked.isBlocked, true);

  for (let i = 0; i < 20; i += 1) await hit("caller");
  await sleep(BLOCK + 20);

  assert.equal((await hit("caller")).isBlocked, false);
});

await test("reports the time left in seconds, rounded up", async () => {
  const record = await hit("caller");
  assert.equal(record.timeToExpire, Math.ceil(TTL / 1000));
  assert.equal(record.timeToBlockExpire, 0);
});

await test("drops a caller once neither its window nor a block still stands", async () => {
  const inspect = () => (storage as unknown as { windows: Map<string, unknown> }).windows;

  for (let i = 0; i < 50; i += 1) await hit(`caller-${i}`);
  assert.equal(inspect().size, 50);

  await sleep(TTL + 20);
  await hit("someone-else");

  assert.equal(inspect().size, 1);
});
