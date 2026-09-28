// Side-effect module: a placeholder DATABASE_URL so generate-openapi.ts can boot AppModule with no database.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://openapi-generator:unused@openapi.invalid:5432/never-connected";
}
