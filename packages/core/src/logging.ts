import { AsyncLocalStorage } from "node:async_hooks";

/** Structured logging for every unit in this system. */

/** The methods a caller uses. `log` is Nest's name for info level; the emitted record says `info`. */
export type LogMethod = "log" | "error" | "warn" | "debug" | "verbose";

/** What the record's `level` says. JSON log consumers expect these, not Nest's method names. */
export type LogLevel = "info" | "error" | "warn" | "debug" | "verbose";

const LEVEL_BY_METHOD: Readonly<Record<LogMethod, LogLevel>> = {
  log: "info",
  error: "error",
  warn: "warn",
  debug: "debug",
  verbose: "verbose",
};

/** A field value that may appear in a record. Deliberately narrow — see the leak-path note above. */
export type LogValue = string | number | boolean | null | undefined | readonly (string | number | boolean | null)[] | Error;

/**
 * Fields a call site may attach. `component` is deliberately **not** one of them: it is the logger's identity
 * and travels as its own parameter, so a call site cannot claim to be a different component.
 */
export type LogFields = {
  job_id?: string;
  request_id?: string;
  [key: string]: LogValue;
};

/** Keys the record owns. A caller cannot overwrite them — see `partitionFields`. */
const RESERVED_KEYS = ["ts", "level", "component", "msg"] as const;

const scope = new AsyncLocalStorage<LogFields>();

/**
 * Runs `fn` with `fields` merged into the ambient log context, so **every** record emitted inside it — at any
 * call depth, across `await`s — carries them without being passed down.
 */
export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
  return scope.run({ ...scope.getStore(), ...fields }, fn);
}

/** The ambient context, or `{}` outside any `runWithLogContext`. */
export function currentLogContext(): LogFields {
  return scope.getStore() ?? {};
}

/**
 * Splits caller fields into what may be emitted and what may not, so the outcome is visible in the record
 * rather than silent:
 */
function partitionFields(fields: LogFields): {
  emit: Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>;
  droppedReserved: string[];
  droppedFields: string[];
} {
  const emit: Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]> = {};
  const droppedReserved: string[] = [];
  const droppedFields: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if ((RESERVED_KEYS as readonly string[]).includes(key)) {
      droppedReserved.push(key);
      continue;
    }
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      emit[key] = value;
      continue;
    }
    if (value instanceof Error) {
      emit[`${key}_name`] = value.name;
      emit[`${key}_message`] = value.message;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      emit[key] = value as readonly (string | number | boolean | null)[];
      continue;
    }
    droppedFields.push(key);
  }

  return { emit, droppedReserved, droppedFields };
}

/** Injected so a test can assert an exact record. Production passes nothing. */
export type Clock = () => string;

const systemClock: Clock = () => new Date().toISOString();

/** One JSON object, no trailing newline. */
export function formatLogRecord(
  level: LogLevel,
  message: string,
  component: string,
  fields: LogFields,
  clock: Clock = systemClock,
): string {
  const { emit, droppedReserved, droppedFields } = partitionFields(fields);
  const { job_id, request_id, ...others } = emit;

  const record: Record<string, unknown> = {
    ts: clock(),
    level,
    // A record that cannot be attributed to a component does not satisfy O1, so an empty component is named
    // rather than omitted — an absent field reads as "not applicable", which it never is.
    component: component.trim() === "" ? "unknown" : component,
    msg: message,
  };
  if (job_id !== undefined) record.job_id = job_id;
  if (request_id !== undefined) record.request_id = request_id;
  for (const key of Object.keys(others).sort()) record[key] = others[key];
  if (droppedReserved.length > 0) record.dropped_reserved = droppedReserved.sort();
  if (droppedFields.length > 0) record.dropped_fields = droppedFields.sort();

  return JSON.stringify(record);
}

/** Where a formatted record goes. Injected so a test can capture instead of writing to the process. */
export type LogSink = (level: LogLevel, line: string) => void;

/** `warn`/`error` to stderr, everything else to stdout — the split Nest's own logger makes. */
const processSink: LogSink = (level, line) => {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/** Every record to stderr, whatever its level. **`services/builder` must use this one.** */
export const stderrOnlySink: LogSink = (_level, line) => {
  process.stderr.write(`${line}\n`);
};

export type ScvsLoggerOptions = { clock?: Clock; sink?: LogSink };

/**
 * One logger per **component**, which is the O1 requirement the current code misses: today every `new
 * Logger(...)` in this repo passes the *service* name, giving two distinct contexts across the whole
 * repository.
 */
export class ScvsLogger {
  private readonly clock: Clock;
  private readonly sink: LogSink;

  constructor(
    private readonly component: string,
    options: ScvsLoggerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.sink = options.sink ?? processSink;
  }

  log(message: string, fields?: LogFields): void {
    this.emit("log", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }

  verbose(message: string, fields?: LogFields): void {
    this.emit("verbose", message, fields);
  }

  /**
   * `fields` is typed but not trusted: when Nest itself logs through this instance it passes extra positional
   * strings (a stack trace, a context name), and a logger that forwarded whatever an uncontrolled caller passed
   * would be the leak path this module exists not to be.
   */
  private emit(method: LogMethod, message: unknown, fields?: unknown): void {
    const level = LEVEL_BY_METHOD[method];
    const usable = typeof fields === "object" && fields !== null && !Array.isArray(fields) && !(fields instanceof Error);
    const own: LogFields = usable ? (fields as LogFields) : {};
    const dropped = fields !== undefined && !usable ? { dropped_params: 1 } : {};

    this.sink(
      level,
      formatLogRecord(
        level,
        typeof message === "string" ? message : String(message),
        this.component,
        { ...currentLogContext(), ...own, ...dropped },
        this.clock,
      ),
    );
  }
}

/**
 * Nest's `LoggerService`, mirrored locally so `ScvsLogger` can be checked against it without `@nestjs/common`
 * becoming a dependency of the kernel — and therefore of the sandbox image.
 */
type NestLoggerServiceShape = {
  log(message: unknown, ...optionalParams: unknown[]): unknown;
  error(message: unknown, ...optionalParams: unknown[]): unknown;
  warn(message: unknown, ...optionalParams: unknown[]): unknown;
  debug?(message: unknown, ...optionalParams: unknown[]): unknown;
  verbose?(message: unknown, ...optionalParams: unknown[]): unknown;
};

type AssertNestCompatible<T extends NestLoggerServiceShape> = T;
export type _ScvsLoggerIsNestCompatible = AssertNestCompatible<ScvsLogger>;
