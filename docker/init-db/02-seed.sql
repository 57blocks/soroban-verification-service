INSERT INTO "trusted_verifiers" ("verifier_id", "manifest_url", "results_root", "enabled")
VALUES (
  'local-verifier',
  'http://localhost:5000/public/verifier-manifest.json',
  'http://localhost:5000/public',
  true
)
ON CONFLICT ("verifier_id") DO NOTHING;
