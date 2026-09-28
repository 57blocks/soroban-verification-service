import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

export const DEFAULT_PING_TIMEOUT_MS = 2_000;

@Injectable()
export class DbHealthService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /** Prisma cannot cancel the raced query, so a timed-out ping leaves its statement running. */
  async ping(timeoutMs: number = DEFAULT_PING_TIMEOUT_MS): Promise<{ ok: boolean; detail?: string }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`database did not answer SELECT 1 within ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
