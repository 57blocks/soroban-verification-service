import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";

/**
 * A per-key fixed-window counter, replacing `@nestjs/throttler`'s bundled storage — which keys its decay
 * timers by throttler NAME, so unblocking one caller cancels every caller's pending decrement and freezes
 * their counts for good. Holding no timers at all is what makes that unreachable here.
 * `test/throttler-storage.spec.ts` fails against the bundled one.
 */

/**
 * `@nestjs/throttler` declares this shape but does not re-export it from the package root, so it is restated
 * here. `implements ThrottlerStorage` still checks it: the interface's own `increment` names the real type.
 */
interface ThrottlerStorageRecord {
  totalHits: number;
  /** Seconds. */
  timeToExpire: number;
  isBlocked: boolean;
  /** Seconds; `0` when not blocked. */
  timeToBlockExpire: number;
}

interface Window {
  hits: number;
  /** Epoch ms. Past it, the next read starts a fresh window rather than decaying the old one. */
  windowExpiresAt: number;
  /** Epoch ms; `0` means never blocked. */
  blockExpiresAt: number;
}

/** Seconds, rounded up — the unit `ThrottlerStorageRecord` reports and `Retry-After` is derived from. */
const secondsUntil = (deadline: number, now: number): number => Math.ceil((deadline - now) / 1000);

@Injectable()
export class FixedWindowThrottlerStorage implements ThrottlerStorage {
  /** Keyed by the guard's own key, which already folds in the caller and the route. */
  private readonly windows = new Map<string, Window>();

  /** Swept in-line rather than on a timer, which would be the background state this class exists without. */
  private nextSweepAt = 0;

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    this.sweep(now, ttl);

    const window = this.windows.get(key) ?? {
      hits: 0,
      windowExpiresAt: now + ttl,
      blockExpiresAt: 0,
    };
    this.windows.set(key, window);

    // A block outlives its window, and refuses without counting, so knocking cannot extend the penalty.
    if (window.blockExpiresAt > now) {
      return {
        totalHits: window.hits,
        timeToExpire: secondsUntil(window.windowExpiresAt, now),
        isBlocked: true,
        timeToBlockExpire: secondsUntil(window.blockExpiresAt, now),
      };
    }

    // Penalty served: start clean rather than resume mid-window.
    if (window.blockExpiresAt !== 0) {
      window.blockExpiresAt = 0;
      window.hits = 0;
      window.windowExpiresAt = now + ttl;
    }

    if (window.windowExpiresAt <= now) {
      window.hits = 0;
      window.windowExpiresAt = now + ttl;
    }

    window.hits += 1;
    if (window.hits > limit) {
      window.blockExpiresAt = now + blockDuration;
    }

    return {
      totalHits: window.hits,
      timeToExpire: secondsUntil(window.windowExpiresAt, now),
      isBlocked: window.blockExpiresAt > now,
      timeToBlockExpire: window.blockExpiresAt > now ? secondsUntil(window.blockExpiresAt, now) : 0,
    };
  }

  /** Drops records no longer standing for anything — neither inside a window nor inside a block. */
  private sweep(now: number, ttl: number): void {
    if (now < this.nextSweepAt) return;
    // One pass per window at most — the cost is proportional to distinct callers.
    this.nextSweepAt = now + ttl;
    for (const [key, window] of this.windows) {
      if (window.windowExpiresAt <= now && window.blockExpiresAt <= now) this.windows.delete(key);
    }
  }
}
