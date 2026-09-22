/**
 * What source-resolution offers the rest of this service. A file in another module imports from here, never from a path
 * inside this directory — so moving or renaming anything below is this module's business alone.
 *
 * Nest's own wiring is the one exception: `*.module.ts` still imports `../source-resolution/source-resolution.module.js`
 * directly, because that is how a module declares what it imports.
 *
 * Enforced by `eng-tools/check-module-surfaces.mjs`.
 */

export * from "./fetch-source-bytes.util.js";
export * from "./source-resolution.service.js";
