import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { BatchEventsModule } from "../batch-events/batch-events.module.js";
import { BuildEnvironmentsModule } from "../build-environments/build-environments.module.js";
import { PublishModule } from "../publish/publish.module.js";
import { VerificationPipelineModule } from "../verification-pipeline/verification-pipeline.module.js";
import { ArchiveRecoveryScheduler } from "./archive-recovery.scheduler.js";
import { BuildDispatchScheduler } from "./build-dispatch.scheduler.js";
import { BuildLogExpiryScheduler } from "./build-log-expiry.scheduler.js";
import { EnvironmentReconcilerScheduler } from "./environment-reconciler.scheduler.js";
import { JobRetentionScheduler } from "./job-retention.scheduler.js";
import { JobRetryScheduler } from "./job-retry.scheduler.js";
import { PublishRecoveryScheduler } from "./publish-recovery.scheduler.js";
import { RebuildReconcilerScheduler } from "./rebuild-reconciler.scheduler.js";
import { SourceArchiveRecoveryScheduler } from "./source-archive-recovery.scheduler.js";
import { SourcePublishRecoveryScheduler } from "./source-publish-recovery.scheduler.js";
import { StartupRecoveryService } from "./startup-recovery.service.js";

@Module({
  // VerificationPipelineModule exports VerificationPipelineService (build-dispatch poll) + BatchDispatchService
  // (startup recovery, and the reconciler's Batch DescribeJobs).
  imports: [
    ScheduleModule.forRoot(),
    VerificationPipelineModule,
    PublishModule,
    BatchEventsModule,
    BuildEnvironmentsModule,
  ],
  providers: [
    StartupRecoveryService,
    BuildDispatchScheduler,
    JobRetryScheduler,
    // Retention, not recovery: it deletes rows the others exist to complete. It runs here because job
    // lifecycle is this service's, and every other lifecycle sweep is on this list.
    JobRetentionScheduler,
    // Earlier than JobRetentionScheduler and for a different reason: that one removes a job's record at 30
    // days, this one removes the raw log at 7 (build-log-access design.md BL-2). Both are idempotent, so a
    // log already gone here is simply nothing for the other to delete.
    BuildLogExpiryScheduler,
    PublishRecoveryScheduler,
    ArchiveRecoveryScheduler,
    // Same rung as ArchiveRecoveryScheduler, for a mainnet+public job's source-archive obligation instead of
    // its report-archive one (mainnet-source-archive design.md MSA-2).
    SourceArchiveRecoveryScheduler,
    SourcePublishRecoveryScheduler,
    // Injects RebuildsRepository (global DbModule) plus BatchDispatchService and RebuildOutcomeService from the
    // two modules imported above.
    RebuildReconcilerScheduler,
    // The same three-rung shape for compositions.
    EnvironmentReconcilerScheduler,
  ],
  exports: [StartupRecoveryService],
})
export class SchedulerModule {}
