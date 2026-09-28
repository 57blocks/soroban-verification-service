import { ScvsLogger } from "./logging.js";

export class DetachedWork {
  private readonly running = new Set<Promise<void>>();
  private draining = false;

  constructor(private readonly logger: ScvsLogger) {}

  /** Silently refused once draining: only pass work whose obligation is already durable. */
  start(work: () => Promise<unknown>): void {
    if (this.draining) return;
    const run: Promise<void> = work()
      .then(
        () => undefined,
        // Backstop: an unhandled rejection would end the process.
        (error: unknown) => {
          this.logger.error("detached work rejected", { error: error instanceof Error ? error : String(error) });
        },
      )
      .finally(() => {
        this.running.delete(run);
      });
    this.running.add(run);
  }

  async drain(): Promise<void> {
    this.draining = true;
    while (this.running.size > 0) await Promise.all(this.running);
  }
}
