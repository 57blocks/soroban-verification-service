/** Erasable TypeScript only, no imports: spa-routes.ts loads this file through Node's type stripping. */
export const ROUTE_PATHS = {
  landing: "/",
  verify: "/verify",
  verifyJob: "/verify/jobs/$job_id",
  terms: "/terms",
  privacy: "/privacy",
  query: "/query",
} as const;

export const CONSOLE_ROUTE_PATHS: readonly string[] = Object.values(ROUTE_PATHS);
