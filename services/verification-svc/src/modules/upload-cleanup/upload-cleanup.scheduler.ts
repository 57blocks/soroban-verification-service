import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, startInterval } from "@scvs/core";
import { UploadCleanupService } from "../../common/upload-cleanup.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Replaces the pre-Nest `setInterval` in server.ts with one `@nestjs/schedule` owns and clears. */
@Injectable()
export class UploadCleanupScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("upload-cleanup");

  // Explicit `@Inject()` — see preflight.controller.ts's comment.
  constructor(
    @Inject(UploadCleanupService) private readonly uploadCleanup: UploadCleanupService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "upload-cleanup",
      this.configService.get("uploadCleanupIntervalMs", { infer: true }),
      () => this.handleCleanup(),
    );
  }

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
