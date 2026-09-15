import { FixedWindowThrottlerStorage } from "../src/common/fixed-window-throttler.storage.js";

/**
 * The defect this storage exists to avoid, pinned as a test.
 *
 * `@nestjs/throttler`'s bundled `ThrottlerStorageService` keeps its decay timers in a list keyed by throttler
 * NAME, and unblocking one caller cancels every caller's pending decrement. Because `increment` refreshes the
 * window's end but never resets `totalHits`, those counts then never come down. The first case below fails
 * against that implementation and passes against this one; the rest are the ordinary behaviour the guard
 * depends on.
 */
const NAME = "default";
const TTL = 200;
const BLOCK = 100;
const LIMIT = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let storage: FixedWindowThrottlerStorage;
beforeEach(() => {
  storage = new FixedWindowThrottlerStorage();
});

const hit = (key: string) => storage.increment(key, TTL, LIMIT, BLOCK, NAME);

describe("one caller's counter is its own", () => {
  it("does not inherit a neighbour's count when that neighbour leaves the blocked state", async () => {
    // A spends its budget and is blocked.
    for (let i = 0; i < LIMIT + 1; i += 1) await hit("attacker");
    expect((await hit("attacker")).isBlocked).toBe(true);

    // B is well inside its own budget while A's block is still standing.
    await sleep(BLOCK + 20);
    await hit("bystander");
    await hit("bystander");

    // The request that takes A out of the blocked state. Against the bundled storage this is what cancels B's
    // pending decrements and freezes its count.
    await hit("attacker");

    // Two full windows later B's count must have gone with them.
    await sleep(TTL * 2 + 20);

    const verdicts: boolean[] = [];
    for (let i = 0; i < LIMIT; i += 1) verdicts.push((await hit("bystander")).isBlocked);
    expect(verdicts).toEqual([false, false, false]);
  });

  it("survives the attacker cycling in and out of the block repeatedly", async () => {
    // The escalation the single cycle above only hints at: each cycle ratcheted every other count upward.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let i = 0; i < LIMIT + 1; i += 1) await hit("attacker");
      await hit("bystander");
      await sleep(BLOCK + 20);
      await hit("attacker");
    }

    await sleep(TTL * 2 + 20);
    expect((await hit("bystander")).totalHits).toBe(1);
  });
});

describe("the window itself", () => {
  it("admits exactly the limit and refuses the next request", async () => {
    const verdicts: boolean[] = [];
    for (let i = 0; i < LIMIT + 1; i += 1) verdicts.push((await hit("caller")).isBlocked);
    expect(verdicts).toEqual([false, false, false, true]);
  });

  it("starts a fresh window once the old one has passed", async () => {
    for (let i = 0; i < LIMIT; i += 1) await hit("caller");
    await sleep(TTL + 20);

    const record = await hit("caller");
    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
  });

  it("does not let a blocked caller extend its own penalty by knocking", async () => {
    for (let i = 0; i < LIMIT + 1; i += 1) await hit("caller");
    const blocked = await hit("caller");
    expect(blocked.isBlocked).toBe(true);

    // Hammering while blocked is not counted, so the block still expires on schedule.
    for (let i = 0; i < 20; i += 1) await hit("caller");
    await sleep(BLOCK + 20);

    expect((await hit("caller")).isBlocked).toBe(false);
  });

  it("reports the time left in seconds, rounded up", async () => {
    const record = await hit("caller");
    expect(record.timeToExpire).toBe(Math.ceil(TTL / 1000));
    expect(record.timeToBlockExpire).toBe(0);
  });
});

describe("records do not accumulate forever", () => {
  it("drops a caller once neither its window nor a block still stands", async () => {
    const inspect = () => (storage as unknown as { windows: Map<string, unknown> }).windows;

    for (let i = 0; i < 50; i += 1) await hit(`caller-${i}`);
    expect(inspect().size).toBe(50);

    // The sweep runs at most once per window, on the next request through — never on a timer, which would
    // hold the event loop open and reintroduce the background state this class avoids.
    await sleep(TTL + 20);
    await hit("someone-else");

    expect(inspect().size).toBe(1);
  });
});
