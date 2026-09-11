/**
 * Side-effect module: plants placeholders for the variables `AppModule` requires at boot but the OpenAPI
 * generator has no use for, **for `generate-openapi.ts` only**. It boots the real AppModule with no
 * environment, so every `required` variable exits 1 — silently, because `logger: false` swallows bootstrap
 * failures. Relaxing the DTO instead would remove the boot-time guarantee from every real process to satisfy
 * the one process that serves nothing.
 *
 * Was `openapi-placeholder-db.ts` with only the database placeholder; SCVS_ABUSE_FINGERPRINT_KEY was the
 * second variable to need it and SCVS_LEGAL_DOCUMENTS_SOURCE is the third.
 */
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://openapi-generator:unused@openapi.invalid:5432/never-connected";
}

if (!process.env.SCVS_ABUSE_FINGERPRINT_KEY) {
  process.env.SCVS_ABUSE_FINGERPRINT_KEY = "openapi-generator-never-fingerprints-anything";
}

// Unlike the two above, this one must point at something real: the legal module reads and validates the
// bundle during `app.init()`. The committed example keeps generation reproducible.
if (!process.env.SCVS_LEGAL_DOCUMENTS_SOURCE) {
  process.env.SCVS_LEGAL_DOCUMENTS_SOURCE = "config/legal-documents.example.json";
}
