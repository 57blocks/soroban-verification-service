export type SchemaHint = {
  nullable?: boolean;
  description?: string;
  example?: unknown;
  type?: string;
  items?: Record<string, unknown>;
  oneOf?: Record<string, unknown>[];
  pattern?: string;
};

/** Stored on the prototype under a global symbol, so every copy of this module sees them. */
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
