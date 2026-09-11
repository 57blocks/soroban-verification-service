import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { DrainState, RETRY_ELIGIBILITY_WINDOW_MS, ScvsLogger } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

// Reads `process.env` directly rather than through `ConfigService`: `@Interval(...)` is a decorator argument,
// evaluated at class-definition time (module load), before Nest's DI container exists.
const JOB_RETRY_INTERVAL_MS = Number(process.env.SCVS_JOB_RETRY_INTERVAL_MS || 60_000);

/** How far back a failure still counts as *live*. */
const ELIGIBILITY_WINDOW_MS = RETRY_ELIGIBILITY_WINDOW_MS;

/** Enough ids to act on; a backlog-sized array in one log record helps nobody. */
const LOGGED_ID_LIMIT = 20;

/**
 * The rule existed in the type system and nowhere else: `isRetryableFailure` had no callers, so a chain lookup
 * that failed on an RPC blip was terminal for that submission and the submitter's only recourse was to
 * resubmit.
 */
@Injectable()
export class JobRetryScheduler {
  private readonly logger = new ScvsLogger("job-retry");

  constructor(
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
  ) {}

  @Interval(JOB_RETRY_INTERVAL_MS)
  async requeueRetryable(): Promise<void> {
    // O9: re-queueing is claiming new work, which a draining node must not do.
    if (this.drain.isDraining) return;
    try {
      const maxAttempts = this.configService.get("maxJobRetryAttempts", { infer: true });
      const requeued = await this.jobs.requeueRetryableFailures(
        maxAttempts,
        new Date(Date.now() - ELIGIBILITY_WINDOW_MS),
      );
      if (requeued.length > 0) {
        // `warn`, not `log`: a retry is a failure that happened, and a rising count is the signal that
        // something upstream is unwell even while every job eventually succeeds.
        this.logger.warn("re-queued jobs that failed for a retryable reason", {
          count: requeued.length,
          job_ids: requeued.slice(0, LOGGED_ID_LIMIT),
          max_attempts: maxAttempts,
        });
      }
    } catch (error) {
      this.logger.error("job-retry scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
