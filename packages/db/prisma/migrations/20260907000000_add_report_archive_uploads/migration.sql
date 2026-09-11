-- CreateTable
CREATE TABLE "report_archive_uploads" (
    "report_sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "tx_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_archive_uploads_pkey" PRIMARY KEY ("report_sha256")
);

-- CreateIndex
CREATE INDEX "report_archive_uploads_status_updated_at_idx" ON "report_archive_uploads"("status", "updated_at");
