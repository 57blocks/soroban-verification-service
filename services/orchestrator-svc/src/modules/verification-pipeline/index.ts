/**
 * What verification-pipeline offers the rest of this service. A file in another module imports from here, never from a path
 * inside this directory — so moving or renaming anything below is this module's business alone.
 *
 * Nest's own wiring is the one exception: `*.module.ts` still imports `../verification-pipeline/verification-pipeline.module.js`
 * directly, because that is how a module declares what it imports.
 *
 * Enforced by `eng-tools/check-module-surfaces.mjs`.
 */

export * from "./batch-dispatch.service.js";
export * from "./verification-pipeline.service.js";
