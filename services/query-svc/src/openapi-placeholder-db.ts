/**
 * Side-effect module: plants a placeholder `DATABASE_URL` so `generate-openapi.ts` can boot the real
 * `AppModule` with no database configured, which is the property AGENTS.md gives that generator.
 */
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://openapi-generator:unused@openapi.invalid:5432/never-connected";
}
