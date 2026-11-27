-- AlterTable
ALTER TABLE "report_archive_uploads" ADD COLUMN "confirmed_at" TIMESTAMP(3),
ADD COLUMN "deadline_height" INTEGER;

-- AlterTable
ALTER TABLE "source_archive_uploads" ADD COLUMN "confirmed_at" TIMESTAMP(3),
ADD COLUMN "deadline_height" INTEGER;
