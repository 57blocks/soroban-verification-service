import { Inject, Injectable } from "@nestjs/common";
import { parseBatchJobStateChangeEvent } from "@scvs/aws";
import { ScvsLogger } from "@scvs/core";
import { EnvironmentsRepository, RebuildsRepository } from "@scvs/db";
import { EnvironmentOutcomeService } from "../build-environments/index.js";
import { RebuildOutcomeService } from "./rebuild-outcome.service.js";

/**
 * It deliberately does **not** compute any job's verdict: its whole responsibility is to turn "Batch job X
 * finished" into "rebuild R produced these bytes / failed this way", and every job attached to R resolves its
 * own verdict on its next poll tick.
 */
@Injectable()
export class BatchEventHandlerService {
  private readonly logger = new ScvsLogger("batch-events");

  constructor(
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(RebuildOutcomeService)
    private readonly outcomes: RebuildOutcomeService,
    @Inject(EnvironmentsRepository)
    private readonly environments: EnvironmentsRepository,
    @Inject(EnvironmentOutcomeService)
    private readonly environmentOutcomes: EnvironmentOutcomeService
  ) {}

  /** SQS consumer entry point (batch-event-consumer.service.ts) for messages off the `JobStateChangeQueue`. */
  async onBatchJobStateChangeEvent(rawEvent: unknown): Promise<void> {
    const parsed = parseBatchJobStateChangeEvent(rawEvent);
    if (!parsed) {
      // A Batch job-state-change event carries `detail.container.environment`, and that is where
      // `SCVS_JOB_PARAMS_JSON` lives — including the job's **presigned S3 PUT URL**.
      this.logger.warn("could not parse Batch event, ignoring", {
        event_shape: describeUnparsedEvent(rawEvent),
      });
      return;
    }
    this.logger.log("Batch job reported a terminal state", {
      batch_job_id: parsed.jobId,
      batch_status: parsed.status,
      status_reason: parsed.statusReason,
    });

    const rebuild = await this.rebuilds.getByBatchJobId(parsed.jobId);
    if (!rebuild) {
      // Not a rebuild — it may be a composition. Checked before the "nobody is tracking this" branch below,
      // because that branch *deletes* the message.
      if (await this.tryRecordEnvironment(parsed)) return;

      // Four ways here, all "delete the message rather than retry forever": a stale or duplicate delivery for a
      // rebuild that has since been requeued (its batch_job_id was cleared), a job from an environment this
      // instance doesn't track, the case `RebuildsRepository.listStuckDispatching` warns about (a duplicate
      // Batch job left over from a crash between Batch accepting and `markDispatched` recording it), or.
      this.logger.warn(
        "no rebuild is tracking this Batch job, ignoring; a queue-sharing environment recovers it " +
          "by reconciliation",
        { batch_job_id: parsed.jobId },
      );
      return;
    }

    if (rebuild.status === "done") {
      // Duplicate delivery of an event we already recorded.
      this.logger.log("rebuild is already terminal, ignoring a duplicate event", {
        rebuild_id: rebuild.rebuildId,
        outcome: rebuild.outcome,
      });
      return;
    }

    await this.outcomes.recordFromBatchTerminalState(rebuild, parsed);
  }

  /** Records a composer job's terminal state, if an `Environment` is the thing tracking it. */
  private async tryRecordEnvironment(event: {
    jobId: string;
    status: string;
    statusReason?: string;
  }): Promise<boolean> {
    const environment = await this.environments.getByBatchJobId(event.jobId);
    if (!environment) return false;

    if (environment.status === "ready" || environment.status === "failed") {
      this.logger.log("environment is already terminal, ignoring a duplicate event", {
        environment_id: environment.environmentId,
        environment_status: environment.status,
      });
      return true;
    }

    this.logger.log("Batch job belongs to a composition, not a rebuild", {
      environment_id: environment.environmentId,
      batch_job_id: event.jobId,
    });
    await this.environmentOutcomes.recordFromBatchTerminalState(environment, event);
    return true;
  }
}

/**
 * A bounded description of an event we could not parse — enough to tell "not ours" from "ours, new schema", and
 * nothing more.
 */
function describeUnparsedEvent(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return typeof raw;
  const keys = Object.keys(raw as Record<string, unknown>).slice(0, 8).sort();
  const detailType = (raw as { "detail-type"?: unknown })["detail-type"];
  const label = typeof detailType === "string" ? detailType : "no detail-type";
  return `${label}; keys: ${keys.join(",")}`;
}
