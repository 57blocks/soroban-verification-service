-- AlterTable
ALTER TABLE "abuse_control" DROP CONSTRAINT "abuse_control_pkey";
ALTER TABLE "abuse_control" ADD COLUMN     "route" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "abuse_control" ADD CONSTRAINT "abuse_control_pkey" PRIMARY KEY ("submitter_fingerprint", "route", "window_start");
