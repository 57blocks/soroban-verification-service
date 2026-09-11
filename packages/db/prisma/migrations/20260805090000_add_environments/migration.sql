-- build-environments Phase 3 (docs/features/build-environments/plan.md §3.4), per ADR-015.
-- Purely additive: one CREATE TABLE, no ALTER of "jobs" or "rebuilds", so existing cli-58 rows read
-- back exactly as before (plan.md §3.4's first migration-safety requirement).
--
-- Amended 2026-08-05, before ever being applied anywhere, to add the unique index on
-- "recipe_sha256": dispatch resolves a cli-legacy Rebuild's environment through exactly one
-- recipe_sha256 -> image_digest lookup (ADR-015 §2), which needs that column both indexed and
-- unambiguous. Amended in place rather than added as a second migration precisely because this one
-- has no applied checksum anywhere yet; once it has, never edit it again — add a follow-up migration.

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "cliver" TEXT NOT NULL,
    "rsver" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "recipe_sha256" TEXT,
    "image_digest" TEXT,
    "recipe" JSONB,
    "error_code" TEXT,
    "batch_job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "environments_recipe_sha256_key" ON "environments"("recipe_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "environments_cliver_rsver_template_version_key" ON "environments"("cliver", "rsver", "template_version");

-- CreateIndex
CREATE INDEX "environments_status_idx" ON "environments"("status");
