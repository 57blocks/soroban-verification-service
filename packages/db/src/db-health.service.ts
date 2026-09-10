import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

/** "Is the connection usable?" — for a readiness probe, and nothing else. */
@Injectable()
export class DbHealthService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * `SELECT 1` rather than a real query: the question is whether the connection works, and the cheapest
   * statement answering it is the one least likely to fail for an unrelated reason (a missing table, a
   * migration mid-flight).
   */
  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
