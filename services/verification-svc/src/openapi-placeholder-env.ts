// For generate-openapi.ts only: without these, boot exits 1 silently because `logger: false` swallows the error.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgresql://openapi-generator:unused@openapi.invalid:5432/never-connected";
}

if (!process.env.SCVS_ABUSE_FINGERPRINT_KEY) {
  process.env.SCVS_ABUSE_FINGERPRINT_KEY = "openapi-generator-never-fingerprints-anything";
}

// Must point at a real bundle: the legal module reads and validates it during `app.init()`.
if (!process.env.SCVS_LEGAL_DOCUMENTS_SOURCE) {
  process.env.SCVS_LEGAL_DOCUMENTS_SOURCE = "config/legal-documents.example.json";
}
