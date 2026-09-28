import { Inject, Injectable } from "@nestjs/common";
import { parseBatchJobStateChangeEvent } from "@scvs/aws";
import { ScvsLogger } from "@scvs/core";
import { EnvironmentsRepository, RebuildsRepository } from "@scvs/db";
import { EnvironmentOutcomeService } from "../build-environments/index.js";
import { RebuildOutcomeService } from "./rebuild-outcome.service.js";

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

  async onBatchJobStateChangeEvent(rawEvent: unknown): Promise<void> {
    const parsed = parseBatchJobStateChangeEvent(rawEvent);
    if (!parsed) {
      // Never log the raw event: its container environment carries a presigned S3 PUT URL.
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
      // Checked before the untracked branch below, which deletes the message.
      if (await this.tryRecordEnvironment(parsed)) return;

      this.logger.warn(
        "no rebuild is tracking this Batch job, ignoring; a queue-sharing environment recovers it " +
          "by reconciliation",
        { batch_job_id: parsed.jobId },
      );
      return;
    }

    if (rebuild.status === "done") {
      this.logger.log("rebuild is already terminal, ignoring a duplicate event", {
        rebuild_id: rebuild.rebuildId,
        outcome: rebuild.outcome,
      });
      return;
    }

    await this.outcomes.recordFromBatchTerminalState(rebuild, parsed);
  }

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

function describeUnparsedEvent(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return typeof raw;
  const keys = Object.keys(raw as Record<string, unknown>).slice(0, 8).sort();
  const detailType = (raw as { "detail-type"?: unknown })["detail-type"];
  const label = typeof detailType === "string" ? detailType : "no detail-type";
  return `${label}; keys: ${keys.join(",")}`;
}
