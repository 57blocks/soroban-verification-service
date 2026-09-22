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
 * same way it clears a decorated one. A tick that rejects is still the scheduler's own problem to catch —
 * unchanged from `@Interval`, which did not handle one either.
 */
export function startInterval(
  registry: IntervalRegistry,
  name: string,
  everyMs: number,
  tick: () => unknown,
): void {
  // `Number(process.env.X || default)` answered `NaN` for a non-numeric value, and an interval of `NaN` fires
  // on every tick of the event loop. Failing at startup is the only honest answer.
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(
      `${name} needs a positive interval in milliseconds; got ${String(everyMs)}. Check its environment variable.`,
    );
  }
  registry.addInterval(
    name,
    setInterval(() => {
      void tick();
    }, everyMs),
  );
}
