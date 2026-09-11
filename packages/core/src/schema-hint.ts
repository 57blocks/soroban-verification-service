// The few schema facts a validator cannot state.

export type SchemaHint = {
  nullable?: boolean;
  description?: string;
  example?: unknown;
  /** Present when the validator gives the converter nothing to go on; replaces the derived shape. */
  type?: string;
  items?: Record<string, unknown>;
  oneOf?: Record<string, unknown>[];
  /** For a string whose only constraint is a custom decorator — a strkey, say — so the document states its shape. */
  pattern?: string;
};

/** Hints live ON the prototype, under a registry-wide symbol, not in a module-local map. */
const HINTS = Symbol.for("scvs.schemaHints");

type Hinted = { [HINTS]?: Map<string, SchemaHint> };

export function SchemaHint(hint: SchemaHint): PropertyDecorator {
  return (target, propertyKey) => {
    const prototype = target as Hinted;
    const forClass = Object.prototype.hasOwnProperty.call(prototype, HINTS)
      ? prototype[HINTS]!
      : new Map<string, SchemaHint>();
    forClass.set(String(propertyKey), { ...forClass.get(String(propertyKey)), ...hint });
    Object.defineProperty(prototype, HINTS, { value: forClass, enumerable: false, configurable: true });
  };
}

/** Every hint that applies to a class, its own and its bases'. */
export function schemaHintsFor(target: Function | undefined): ReadonlyMap<string, SchemaHint> {
  const collected = new Map<string, SchemaHint>();

  let prototype: object | null = target?.prototype ?? null;
  while (prototype !== null && prototype !== Object.prototype) {
    const own = Object.prototype.hasOwnProperty.call(prototype, HINTS) ? (prototype as Hinted)[HINTS] : undefined;
    for (const [property, hint] of own ?? []) {
      if (!collected.has(property)) collected.set(property, hint);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return collected;
}
