import { getMetadataStorage, validateSync } from "class-validator";
// Nested shapes resolve only with this: `@ValidateNested` records that a property is a class, and
// class-transformer's `@Type(() => X)` is the only place X is written down.
// @ts-expect-error -- untyped entry point
import { defaultMetadataStorage } from "class-transformer/cjs/storage.js";
import { BUILD_ARTIFACT_SCHEMA_VERSION } from "./artifact-contract.js";
import { BuildArtifact } from "./batch.js";

/**
 * A machine-readable description of the `recipe.json` wire contract — every class it reaches, every property
 * each declares, and whether validation rejects a document that omits it.
 */
export type ArtifactContractSnapshot = {
  schema_version: string;
  shapes: Record<string, ArtifactContractShape>;
};

export type ArtifactContractShape = {
  properties: Record<string, { absence_rejected: boolean; nested?: string }>;
};

type Constructor = new () => object;

/**
 * Derives the snapshot from the DTOs as they are now. Pure read of the decorator metadata plus one
 * `validateSync` of an empty instance per class — no fixture, no I/O.
 */
export function deriveArtifactContractSnapshot(): ArtifactContractSnapshot {
  const storage = getMetadataStorage();
  const shapes: Record<string, ArtifactContractShape> = {};
  const pending: Constructor[] = [BuildArtifact as unknown as Constructor];

  while (pending.length > 0) {
    const cls = pending.pop();
    if (cls === undefined || shapes[cls.name] !== undefined) continue;

    const metadata = storage.getTargetValidationMetadatas(cls, cls.name, true, false);
    const rejected = new Set(
      validateSync(new cls(), { forbidUnknownValues: false }).map((error) => error.property),
    );
    const properties: ArtifactContractShape["properties"] = {};

    for (const property of [...new Set(metadata.map((entry) => entry.propertyName))].sort()) {
      const nested = metadata.some(
        (entry) => entry.propertyName === property && entry.type === "nestedValidation",
      )
        ? nestedClassOf(cls, property)
        : undefined;
      properties[property] = {
        absence_rejected: rejected.has(property),
        ...(nested ? { nested: nested.name } : {}),
      };
      if (nested) pending.push(nested);
    }

    shapes[cls.name] = { properties };
  }

  return { schema_version: BUILD_ARTIFACT_SCHEMA_VERSION, shapes: sortKeys(shapes) };
}

/** Fails rather than describing a nested property as a scalar. */
function nestedClassOf(cls: Constructor, property: string): Constructor {
  const entry = (
    defaultMetadataStorage as {
      findTypeMetadata(target: Constructor, property: string): { typeFunction?: () => unknown } | undefined;
    }
  ).findTypeMetadata(cls, property);
  const resolved = entry?.typeFunction?.();
  if (typeof resolved !== "function" || resolved === Object) {
    throw new Error(
      `${cls.name}.${property} is @ValidateNested() with no resolvable @Type(() => X) — the wire ` +
        "contract cannot be described until it names its class",
    );
  }
  return resolved as Constructor;
}

function sortKeys<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}
