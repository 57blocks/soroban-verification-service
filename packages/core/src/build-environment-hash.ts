import { createHash } from "node:crypto";
import type { ComposedEnvironmentRecipe } from "./build-environment.js";

// build-environment.ts is bundled for browsers, so `node:crypto` stays in this file.

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeList(items: string[]): string {
  return `${items.length}:${items.join("")}`;
}

/** Length-prefixed, not `JSON.stringify`, so no two recipes can encode to the same bytes. */
export function composedEnvironmentRecipeHash(recipe: ComposedEnvironmentRecipe): string {
  const components = [...recipe.components].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );
  const encodedComponents = encodeList(
    components.map(
      (component) =>
        encodeField(component.kind) + encodeField(component.source) + encodeField(component.sha256),
    ),
  );
  const canonical =
    encodeField(recipe.schema) +
    encodeField(recipe.template_version) +
    encodeField(recipe.pair.cliver) +
    encodeField(recipe.pair.rsver) +
    encodedComponents;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
