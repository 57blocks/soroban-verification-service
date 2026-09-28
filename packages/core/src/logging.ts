import { AsyncLocalStorage } from "node:async_hooks";

export type LogMethod = "log" | "error" | "warn" | "debug" | "verbose";

export type LogLevel = "info" | "error" | "warn" | "debug" | "verbose";

const LEVEL_BY_METHOD: Readonly<Record<LogMethod, LogLevel>> = {
  log: "info",
  error: "error",
  warn: "warn",
  debug: "debug",
  verbose: "verbose",
};

export type LogValue = string | number | boolean | null | undefined | readonly (string | number | boolean | null)[] | Error;

export type LogFields = {
  job_id?: string;
  request_id?: string;
  [key: string]: LogValue;
};

const RESERVED_KEYS = ["ts", "level", "component", "msg"] as const;

const scope = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
  return scope.run({ ...scope.getStore(), ...fields }, fn);
}

export function currentLogContext(): LogFields {
  return scope.getStore() ?? {};
}

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

export type Clock = () => string;

const systemClock: Clock = () => new Date().toISOString();

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

export type LogSink = (level: LogLevel, line: string) => void;

const processSink: LogSink = (level, line) => {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/** Every record to stderr; `services/builder` must use this, as its stdout carries only the result. */
export const stderrOnlySink: LogSink = (_level, line) => {
  process.stderr.write(`${line}\n`);
};

export type ScvsLoggerOptions = { clock?: Clock; sink?: LogSink };

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

  /** Nest passes extra positional strings here, so `fields` is untrusted despite its type. */
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

type NestLoggerServiceShape = {
  log(message: unknown, ...optionalParams: unknown[]): unknown;
  error(message: unknown, ...optionalParams: unknown[]): unknown;
  warn(message: unknown, ...optionalParams: unknown[]): unknown;
  debug?(message: unknown, ...optionalParams: unknown[]): unknown;
  verbose?(message: unknown, ...optionalParams: unknown[]): unknown;
};

type AssertNestCompatible<T extends NestLoggerServiceShape> = T;
export type _ScvsLoggerIsNestCompatible = AssertNestCompatible<ScvsLogger>;
