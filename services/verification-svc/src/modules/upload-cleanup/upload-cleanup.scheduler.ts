import { Inject, Injectable } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ScvsLogger } from "@scvs/core";
import { UploadCleanupService } from "../../common/upload-cleanup.js";

// Reads `process.env` directly rather than through `ConfigService`: `@Interval(...)` is a decorator argument,
// evaluated at class-definition time (module load), before Nest's DI container exists.
const INTERVAL_MS = Number(process.env.SCVS_UPLOAD_CLEANUP_INTERVAL_MS || 60_000);

/** Replaces the pre-Nest `setInterval` in server.ts with `@nestjs/schedule`'s `@Interval` decorator. */
@Injectable()
export class UploadCleanupScheduler {
  private readonly logger = new ScvsLogger("upload-cleanup");

  // Explicit `@Inject()` — see preflight.controller.ts's comment.
  constructor(
    @Inject(UploadCleanupService) private readonly uploadCleanup: UploadCleanupService,
  ) {}

  @Interval(INTERVAL_MS)
  async handleCleanup(): Promise<void> {
    try {
      await this.uploadCleanup.cleanupExpiredUploads();
    } catch (error) {
      // A silent failure here leaves submitted bytes on disk past their expiry, so it is an error record, not a
      // warning.
      this.logger.error("upload cleanup sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
