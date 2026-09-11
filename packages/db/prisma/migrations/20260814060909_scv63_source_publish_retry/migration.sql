-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "source_file_name" TEXT,
ADD COLUMN     "source_publish_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "source_publish_pending_since" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "upload_job_references" (
    "upload_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_job_references_pkey" PRIMARY KEY ("upload_id","job_id")
);

-- CreateIndex
CREATE INDEX "upload_job_references_upload_id_idx" ON "upload_job_references"("upload_id");

-- CreateIndex
CREATE INDEX "jobs_source_publish_pending_since_idx" ON "jobs"("source_publish_pending_since");
