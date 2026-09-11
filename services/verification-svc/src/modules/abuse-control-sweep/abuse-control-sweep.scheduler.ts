import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { ScvsLogger } from "@scvs/core";
import { AbuseControlRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

// Reads `process.env` directly rather than through `ConfigService`: `@Interval(...)` is a decorator argument,
// evaluated at class-definition time (module load), before Nest's DI container exists.
const INTERVAL_MS = Number(process.env.SCVS_ABUSE_SWEEP_INTERVAL_MS || 300_000);

/** Keeps `abuse_control` inside its retention window (retention-and-pseudonymisation design.md RP-2). */
@Injectable()
export class AbuseControlSweepScheduler {
  private readonly logger = new ScvsLogger("abuse-control-sweep");

  // Explicit `@Inject()` — see preflight.controller.ts's comment.
  constructor(
    @Inject(AbuseControlRepository) private readonly abuseControl: AbuseControlRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
  ) {}

  @Interval(INTERVAL_MS)
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
