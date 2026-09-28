import { Module } from "@nestjs/common";
import { UploadCleanupService } from "../../common/upload-cleanup.js";
import { UploadCleanupScheduler } from "./upload-cleanup.scheduler.js";

@Module({
  providers: [UploadCleanupScheduler, UploadCleanupService],
})
export class UploadCleanupModule {}
