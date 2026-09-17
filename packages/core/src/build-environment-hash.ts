import { createHash } from "node:crypto";
import type { ComposedEnvironmentRecipe } from "./build-environment.js";

// Split from build-environment.ts: that file is now imported through the `@scvs/core/build-environment` subpath
// by packages/storage-layout's browser-bundleable `shapes.ts`, and `node:crypto` is not browser-safe —
// clients/sdk's `browser-graph-test.ts` walks exactly this graph and fails on a Node builtin reachable from it.

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function encodeList(items: string[]): string {
  return `${items.length}:${items.join("")}`;
}

/** Not `JSON.stringify` — that is the K2/K4 bug class already fixed once for the idempotency key. */
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
