/*
  Warnings:

  - You are about to drop the column `result_s3_key` on the `jobs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "jobs" DROP COLUMN "result_s3_key";
