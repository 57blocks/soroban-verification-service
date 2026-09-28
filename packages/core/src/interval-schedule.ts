import type { DetachedWork } from "./detached-work.js";
import { ScvsLogger } from "./logging.js";

export type IntervalRegistry = {
  addInterval(name: string, ref: ReturnType<typeof setInterval>): void;
};

export function startInterval(
  registry: IntervalRegistry,
  name: string,
  everyMs: number,
  tick: () => unknown,
  work: DetachedWork,
): void {
  // An interval of `NaN` fires on every event-loop tick.
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(
      `${name} needs a positive interval in milliseconds; got ${String(everyMs)}. Check its environment variable.`,
    );
  }

  const ref = setInterval(() => {
    // Caught so a rejecting tick is logged instead of crashing the process.
    work.start(() =>
      Promise.resolve()
        .then(tick)
        .catch((error: unknown) => {
          new ScvsLogger(name).error("scheduled tick rejected; the schedule continues", {
            error: error instanceof Error ? error : String(error),
          });
        }),
    );
  }, everyMs);

  // Only the HTTP listener may keep the process alive.
  ref.unref();

  registry.addInterval(name, ref);
}
