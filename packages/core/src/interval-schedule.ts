import { DetachedWork } from "./detached-work.js";
import { ScvsLogger } from "./logging.js";

/**
 * Starting a scheduler's interval once the DI container exists, instead of in an `@Interval(...)` decorator.
 *
 * A decorator argument is evaluated at class-definition time — module load, before Nest has built anything —
 * so a scheduler using one cannot read `ConfigService` and had to read `process.env` itself. That is why every
 * interval knob used to carry a second default beside the one in its service's `configuration.ts`, and why
 * changing the entry there did nothing.
 */

/** `@nestjs/schedule`'s `SchedulerRegistry`, structurally: this package carries no Nest dependency. */
export type IntervalRegistry = {
  addInterval(name: string, ref: ReturnType<typeof setInterval>): void;
};

/**
 * Registers `tick` to run every `everyMs`. The registry owns the handle, so Nest clears it on shutdown the
 * same way it clears a decorated one. Ticks run through `work`, so draining it stops them and awaits the last.
 */
export function startInterval(
  registry: IntervalRegistry,
  name: string,
  everyMs: number,
  tick: () => unknown,
  work: DetachedWork = new DetachedWork(new ScvsLogger(name)),
): void {
  // `Number(process.env.X || default)` answered `NaN` for a non-numeric value, and an interval of `NaN` fires
  // on every tick of the event loop. Failing at startup is the only honest answer.
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(
      `${name} needs a positive interval in milliseconds; got ${String(everyMs)}. Check its environment variable.`,
    );
  }

  const ref = setInterval(() => {
    // A tick that rejects would otherwise be an unhandled rejection, which Node turns into a fatal error —
    // taking down a service over one failed sweep. Every scheduler already catches and logs its own failures,
    // so reaching here is a bug in the tick, and the honest thing is to record it and keep the schedule.
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

  // The service's HTTP listener is what keeps the process alive; a sweep timer must never be the reason it
  // stays up. Without this a test harness that builds the app holds the runner open after its last assertion.
  ref.unref();

  registry.addInterval(name, ref);
}
