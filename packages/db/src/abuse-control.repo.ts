import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

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

  async pruneCountersBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.abuseControl.deleteMany({ where: { windowStart: { lt: cutoff } } });
    return count;
  }
}
