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
   * `SELECT 1` rather than a real query: the question is whether the connection works, and the cheapest
   * statement answering it is the one least likely to fail for an unrelated reason.
   *
   * Bounded, because the interesting failure is not the one that throws. `connectionTimeoutMillis`
   * (`packages/db/src/client.ts`) bounds acquiring a connection; nothing bounds a server that accepted the
   * statement and then stopped answering — a failover mid-flight, a network black hole. Unbounded, the probe
   * hangs instead of reporting, and a readiness route that never answers tells the balancer less than one that
   * answers "not ready".
   *
   * The race does not cancel the query — Prisma exposes no cancellation here — so a timed-out ping leaves its
   * statement running until the driver gives up. That is the accepted cost: the alternative is a probe that
   * holds the request open for as long as the database stays silent.
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
      // Without this the pending timer keeps the event loop alive for `timeoutMs` after every healthy probe,
      // which is what makes a Jest suite hang on a passing test.
      if (timer) clearTimeout(timer);
    }
  }
}
