import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, startInterval } from "@scvs/core";
import { AbuseControlRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

/** Keeps `abuse_control` inside its retention window (retention-and-pseudonymisation design.md RP-2). */
@Injectable()
export class AbuseControlSweepScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("abuse-control-sweep");

  // Explicit `@Inject()` — see preflight.controller.ts's comment.
  constructor(
    @Inject(AbuseControlRepository) private readonly abuseControl: AbuseControlRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "abuse-control-sweep",
      this.configService.get("abuseSweepIntervalMs", { infer: true }),
      () => this.handleSweep(),
    );
  }

  async handleSweep(): Promise<void> {
    try {
      const retentionMs = this.configService.get("abuseCounterRetentionMs", { infer: true });
      const removed = await this.abuseControl.pruneCountersBefore(new Date(Date.now() - retentionMs));
      if (removed > 0) this.logger.log("pruned expired abuse counters", { removed, retention_ms: retentionMs });
    } catch (error) {
      // A silent failure here is a retention breach that nothing else reports, so it is an error record.
      this.logger.error("abuse counter sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
