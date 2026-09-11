import "reflect-metadata";
import { validationMetadatasToSchemas } from "class-validator-jsonschema";
import { getMetadataStorage } from "class-validator";
// Nested shapes resolve only with this: `@ValidateNested` says a property is a class, and class-transformer's
// `@Type(() => X)` is the only place X is recorded.
// @ts-expect-error -- untyped entry point; only passed through to the converter
import { defaultMetadataStorage } from "class-transformer/cjs/storage.js";
import type { OpenAPIObject } from "@nestjs/swagger";
import { schemaHintsFor } from "@scvs/core";

// Derives OpenAPI schemas from the class-validator metadata the DTOs already carry, so no shared package needs
// a Nest dependency to be documented.

const REF_PREFIX = "#/components/schemas/";

type Schema = Record<string, unknown>;

/**
 * Replaces the schemas Nest registered from route models with ones derived from validation, then pulls in every
 * schema those reference, transitively.
 */
export function applyDerivedSchemas(document: OpenAPIObject): OpenAPIObject {
  const derived = validationMetadatasToSchemas({
    refPointerPrefix: REF_PREFIX,
    classTransformerMetadataStorage: defaultMetadataStorage,
  }) as Record<string, Schema>;
  const components = (document.components ??= {});
  const schemas = ((components.schemas ??= {}) as Record<string, Schema>);

  const classes = decoratedClasses();
  const pending = Object.keys(schemas);
  const seen = new Set<string>();

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);

    const schema = derived[name];
    // A name with no derived schema is a DTO Nest documented by hand with no validators.
    if (schema !== undefined) {
      schemas[name] = merge(schemas[name], withHints(classes.get(name), { type: "object", ...schema }));
    }
    pending.push(...referencedNames(schemas[name]));
  }
  assertSound(schemas);
  return document;
}

/** Fails generation rather than publishing a document that is wrong in a way no consumer can work around. */
function assertSound(schemas: Record<string, Schema>): void {
  const problems: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    for (const referenced of referencedNames(schema)) {
      if (!(referenced in schemas)) {
        problems.push(`${name} references ${referenced}, which no schema defines`);
      }
    }
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [property, value] of Object.entries(properties)) {
      if (Object.keys(value).length === 0) {
        problems.push(`${name}.${property} derived to an empty schema — it needs a type validator`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`the derived OpenAPI document is unsound:\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * Declared wins, **per property**. A service may still write `@ApiProperty` on its own DTOs, and what it states
 * by hand is more specific than what validation implies.
 */
function merge(declared: Schema | undefined, derivedSchema: Schema): Schema {
  if (declared === undefined) return derivedSchema;

  const declaredProperties = (declared.properties ?? {}) as Record<string, Schema>;
  const derivedProperties = (derivedSchema.properties ?? {}) as Record<string, Schema>;
  const onlyDerived = Object.keys(derivedProperties).filter((key) => !(key in declaredProperties));

  const declaredRequired = (declared.required ?? []) as string[];
  const derivedRequired = (derivedSchema.required ?? []) as string[];

  return {
    ...derivedSchema,
    ...declared,
    properties: { ...derivedProperties, ...declaredProperties },
    // A property Nest never saw is required only if validation says so; Nest's own answer stands for everything
    // it did document.
    required: [...declaredRequired, ...derivedRequired.filter((key) => onlyDerived.includes(key))],
  };
}

function referencedNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referencedNames);
  if (typeof value !== "object" || value === null) return [];

  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof nested === "string" && nested.startsWith(REF_PREFIX)) {
      found.push(nested.slice(REF_PREFIX.length));
    } else {
      found.push(...referencedNames(nested));
    }
  }
  return found;
}

/** The decorated classes, by name — the same key a schema is registered under. */
function decoratedClasses(): Map<string, Function> {
  const storage = getMetadataStorage() as unknown as { validationMetadatas?: Map<unknown, unknown> };
  const targets = [...(storage.validationMetadatas?.keys() ?? [])];
  return new Map(
    targets.filter((target): target is Function => typeof target === "function").map((t) => [t.name, t]),
  );
}

function withHints(target: Function | undefined, schema: Schema): Schema {
  const hints = schemaHintsFor(target);
  if (hints.size === 0) return schema;

  const properties = { ...((schema.properties ?? {}) as Record<string, Schema>) };
  for (const [property, hint] of hints) {
    if (!(property in properties)) {
      throw new Error(
        `@SchemaHint on ${target?.name ?? "?"}.${property}, which has no derived schema property`,
      );
    }
    // A shape hint replaces what was derived: the property only has one because its validator was opaque to the
    // converter, and what it derived (`$ref: Array`) is the thing being corrected.
    const { $ref: _dropped, ...derived } = properties[property];
    const base = hint.type !== undefined || hint.oneOf !== undefined ? derived : properties[property];
    properties[property] = { ...base, ...hint };
  }
  return { ...schema, properties };
}
