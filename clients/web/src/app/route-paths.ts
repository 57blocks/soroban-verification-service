/**
 * The console's whole route surface, read by the `path:` declarations in `src/features/<feature>/routes/` and by
 * `spa-routes.ts`, which renders nginx `location` blocks from it so an unrouted path answers 404.
 *
 * Erasable TypeScript only, and no imports: the renderer loads this file on Node's type stripping, which
 * refuses anything needing a transform. `<Link to="…">` call sites keep their literals — TanStack checks
 * those against the built tree, which is stronger than referencing a constant.
 */
export const ROUTE_PATHS = {
  /** The landing page is the root route; nothing redirects off `/`. */
  landing: "/",
  /** The submission console. */
  verify: "/verify",
  verifyJob: "/verify/jobs/$job_id",
  terms: "/terms",
  privacy: "/privacy",
  query: "/query",
} as const;

export const CONSOLE_ROUTE_PATHS: readonly string[] = Object.values(ROUTE_PATHS);
