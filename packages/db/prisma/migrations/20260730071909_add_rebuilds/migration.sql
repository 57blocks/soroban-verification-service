-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "rebuild_id" UUID;

-- CreateTable
CREATE TABLE "rebuilds" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "source_ref" JSONB NOT NULL,
    "build_options" JSONB NOT NULL,
    "image_digest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "batch_job_id" TEXT,
    "build_mode" TEXT,
    "outcome" TEXT,
    "runner" TEXT,
    "rebuilt_wasm_hash" TEXT,
    "error_code" TEXT,
    "diagnostics" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rebuilds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rebuilds_idempotency_key_key" ON "rebuilds"("idempotency_key");

-- CreateIndex
CREATE INDEX "rebuilds_status_idx" ON "rebuilds"("status");

-- CreateIndex
CREATE INDEX "jobs_rebuild_id_idx" ON "jobs"("rebuild_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_rebuild_id_fkey" FOREIGN KEY ("rebuild_id") REFERENCES "rebuilds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
