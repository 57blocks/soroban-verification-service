import { Inject, Injectable } from "@nestjs/common";
import { PRISMA_CLIENT } from "./db.tokens.js";
import type { PrismaClient } from "./client.js";

/** Only reached by a caller that omits the bound — see `ping`. */
export const DEFAULT_PING_TIMEOUT_MS = 2_000;

/** "Is the connection usable?" — for query-svc's own readiness probe. */
@Injectable()
export class DbHealthService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * `SELECT 1`, bounded: `connectionTimeoutMillis` covers acquiring a connection, nothing covers a server that
   * accepted the statement and then went quiet, and an unbounded probe hangs rather than reporting. The race
   * cannot cancel the query — Prisma exposes none — so a timed-out ping leaves its statement running.
   */
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
      // Otherwise the pending timer holds the event loop open for `timeoutMs` after every healthy probe.
      if (timer) clearTimeout(timer);
    }
  }
}
