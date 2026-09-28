CREATE TABLE IF NOT EXISTS "jobs" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "contract_id" TEXT,
    "wasm_hash" TEXT,
    "network" TEXT NOT NULL,
    "verification_mode" TEXT NOT NULL,
    "source_ref" JSONB NOT NULL,
    "build_options" JSONB NOT NULL,
    "image_digest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failure_reason" TEXT,
    "batch_job_id" TEXT,
    "build_mode" TEXT,
    "result_s3_key" TEXT,
    "manifest" JSONB,
    "result_summary" JSONB,
    "error_code" TEXT,
    "progress_step" TEXT,
    "progress_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "trusted_verifiers" (
    "verifier_id" TEXT NOT NULL,
    "manifest_url" TEXT NOT NULL,
    "results_root" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_verifiers_pkey" PRIMARY KEY ("verifier_id")
);

CREATE TABLE IF NOT EXISTS "abuse_control" (
    "submitter_fingerprint" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "abuse_control_pkey" PRIMARY KEY ("submitter_fingerprint","window_start")
);

CREATE TABLE IF NOT EXISTS "uploads" (
    "id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "path" TEXT,
    "filename" TEXT,
    "size_bytes" INTEGER,
    "source_sha256" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'jobs_idempotency_key_key') THEN
    CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'jobs_contract_id_network_idx') THEN
    CREATE INDEX "jobs_contract_id_network_idx" ON "jobs"("contract_id", "network");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'jobs_status_idx') THEN
    CREATE INDEX "jobs_status_idx" ON "jobs"("status");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'jobs_wasm_hash_idx') THEN
    CREATE INDEX "jobs_wasm_hash_idx" ON "jobs"("wasm_hash");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uploads_expires_at_idx') THEN
    CREATE INDEX "uploads_expires_at_idx" ON "uploads"("expires_at");
  END IF;
END $$;

-- Record in _prisma_migrations so `prisma migrate deploy` recognises these as already applied and skips them.

CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
VALUES
  ('init-local-001', 'local-dev-init', now(), '20260720082818_init',           1),
  ('init-local-002', 'local-dev-init', now(), '20260721000000_add_job_build_mode', 1)
ON CONFLICT ("id") DO NOTHING;
