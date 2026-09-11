import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

/**
 * Minimal CRUD over the sliding-window `abuse_control` counter (composite key
 * submitterFingerprint+route+windowStart).
 */
@Injectable()
export class AbuseControlRepository {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async incrementAbuseCounter(submitterFingerprint: string, route: string, windowStart: Date): Promise<number> {
    const row = await this.prisma.abuseControl.upsert({
      where: { submitterFingerprint_route_windowStart: { submitterFingerprint, route, windowStart } },
      create: { submitterFingerprint, route, windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    return row.count;
  }

  async getAbuseCount(submitterFingerprint: string, route: string, windowStart: Date): Promise<number> {
    const row = await this.prisma.abuseControl.findUnique({
      where: { submitterFingerprint_route_windowStart: { submitterFingerprint, route, windowStart } },
    });
    return row?.count ?? 0;
  }

  /**
   * Drops counters whose window closed before `cutoff`. Every read above is keyed on the CURRENT window, so
   * such a row is unreachable by any code path and is retained liability only
   * (retention-and-pseudonymisation design.md RP-2). Table-wide by design — this is the production sweep, not
   * the test-suite shape ADR-015 forbids.
   */
  async pruneCountersBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.abuseControl.deleteMany({ where: { windowStart: { lt: cutoff } } });
    return count;
  }
}
