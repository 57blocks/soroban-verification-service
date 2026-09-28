import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, ScvsLogger, startInterval } from "@scvs/core";
import { UploadCleanupService } from "../../common/upload-cleanup.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class UploadCleanupScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("upload-cleanup");
  private readonly detached = new DetachedWork(this.logger);

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
      this.detached,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async handleCleanup(): Promise<void> {
    try {
      await this.uploadCleanup.cleanupExpiredUploads();
    } catch (error) {
      this.logger.error("upload cleanup sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
