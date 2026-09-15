import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";

/**
 * A per-key fixed-window counter, replacing `@nestjs/throttler`'s bundled `ThrottlerStorageService`.
 *
 * ★ **The bundled one lets any caller clear every other caller's counter.** It decays a count with one
 * `setTimeout` per hit and keeps those timer ids in a list keyed by throttler NAME, not by caller. Unblocking
 * one key calls `clearExpirationTimes(throttlerName)`, which cancels the pending decrements of every key under
 * that name; since `increment` refreshes `expiresAt` but never resets `totalHits`, the cancelled counts are
 * stuck for good. An attacker who cycles in and out of the blocked state therefore ratchets every other
 * caller's count upward until they are refused inside their own budget — a cross-caller denial of service.
 * 6.5.0 is the latest release and still does this, so the storage is replaced rather than upgraded.
 *
 * This holds no timers at all: a window is a pair of numbers, and whether it has passed is decided when the
 * next request reads it. Nothing one caller does can touch another caller's record.
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

  /**
   * A record per caller would otherwise outlive its window forever, so a long-running process accumulates one
   * entry per address it has ever seen. Swept in-line rather than on a timer: a timer here would be the same
   * kind of background state this class exists to avoid, and would hold the event loop open.
   */
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

    // A block outlives its window: while it stands, the request is refused without being counted, so a client
    // hammering a closed door cannot extend its own penalty.
    if (window.blockExpiresAt > now) {
      return {
        totalHits: window.hits,
        timeToExpire: secondsUntil(window.windowExpiresAt, now),
        isBlocked: true,
        timeToBlockExpire: secondsUntil(window.blockExpiresAt, now),
      };
    }

    // Expired block: the penalty is served, and the caller starts clean rather than resuming mid-window.
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
    // One pass per window at most: the cost is proportional to distinct callers, and paying it on every
    // request would make a busy process sweep thousands of times a second for nothing.
    this.nextSweepAt = now + ttl;
    for (const [key, window] of this.windows) {
      if (window.windowExpiresAt <= now && window.blockExpiresAt <= now) this.windows.delete(key);
    }
  }
}
