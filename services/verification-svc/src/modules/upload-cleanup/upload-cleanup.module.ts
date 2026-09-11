import { Module } from "@nestjs/common";
import { UploadCleanupService } from "../../common/upload-cleanup.js";
import { UploadCleanupScheduler } from "./upload-cleanup.scheduler.js";

/**
 * Wraps the `@Interval`-driven expired-upload sweep as its own feature module (was a bare
 * `UploadCleanupScheduler` provider on AppModule).
 */
@Module({
  providers: [UploadCleanupScheduler, UploadCleanupService],
})
export class UploadCleanupModule {}
