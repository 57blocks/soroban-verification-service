-- CreateTable
CREATE TABLE "jobs" (
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

-- CreateTable
CREATE TABLE "trusted_verifiers" (
    "verifier_id" TEXT NOT NULL,
    "manifest_url" TEXT NOT NULL,
    "results_root" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_verifiers_pkey" PRIMARY KEY ("verifier_id")
);

-- CreateTable
CREATE TABLE "abuse_control" (
    "submitter_fingerprint" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "abuse_control_pkey" PRIMARY KEY ("submitter_fingerprint","window_start")
);

-- CreateTable
CREATE TABLE "uploads" (
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

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_contract_id_network_idx" ON "jobs"("contract_id", "network");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_wasm_hash_idx" ON "jobs"("wasm_hash");

-- CreateIndex
CREATE INDEX "uploads_expires_at_idx" ON "uploads"("expires_at");
