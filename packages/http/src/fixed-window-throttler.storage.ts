import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";

// Replaces the bundled throttler storage, whose name-keyed decay timers freeze every caller's count once one unblocks.

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

interface Window {
  hits: number;
  windowExpiresAt: number;
  blockExpiresAt: number;
}

const secondsUntil = (deadline: number, now: number): number => Math.ceil((deadline - now) / 1000);

@Injectable()
export class FixedWindowThrottlerStorage implements ThrottlerStorage {
  private readonly windows = new Map<string, Window>();

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

    // A block outlives its window and refuses without counting, so knocking cannot extend the penalty.
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

  private sweep(now: number, ttl: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + ttl;
    for (const [key, window] of this.windows) {
      if (window.windowExpiresAt <= now && window.blockExpiresAt <= now) this.windows.delete(key);
    }
  }
}
