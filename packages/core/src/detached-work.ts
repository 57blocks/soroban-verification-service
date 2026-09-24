import { ScvsLogger } from "./logging.js";

/**
 * Work a service starts without awaiting, held so its shutdown can wait for it instead of closing the database
 * underneath it.
 */
export class DetachedWork {
  private readonly running = new Set<Promise<void>>();
  private draining = false;

  constructor(private readonly logger: ScvsLogger) {}

  /**
   * Runs `work` without awaiting it. Once draining, `work` is silently refused, so only work whose obligation is
   * already durable, which a later scan will pick up, belongs here.
   */
  start(work: () => Promise<unknown>): void {
    if (this.draining) return;
    const run: Promise<void> = work()
      .then(
        () => undefined,
        // A backstop: callers catch their own failures, and an unhandled rejection would end the process.
        (error: unknown) => {
          this.logger.error("detached work rejected", { error: error instanceof Error ? error : String(error) });
        },
      )
      .finally(() => {
        this.running.delete(run);
      });
    this.running.add(run);
  }

  /** Refuses new work, then resolves once everything already started has settled. */
  async drain(): Promise<void> {
    this.draining = true;
    while (this.running.size > 0) await Promise.all(this.running);
  }
}
