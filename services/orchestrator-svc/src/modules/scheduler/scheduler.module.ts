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
import { StatusLinkRecoveryScheduler } from "./status-link-recovery.scheduler.js";
import { SourcePublishRecoveryScheduler } from "./source-publish-recovery.scheduler.js";
import { StartupRecoveryService } from "./startup-recovery.service.js";

@Module({
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
    JobRetentionScheduler,
    BuildLogExpiryScheduler,
    PublishRecoveryScheduler,
    ArchiveRecoveryScheduler,
    SourceArchiveRecoveryScheduler,
    StatusLinkRecoveryScheduler,
    SourcePublishRecoveryScheduler,
    RebuildReconcilerScheduler,
    EnvironmentReconcilerScheduler,
  ],
  exports: [StartupRecoveryService],
})
export class SchedulerModule {}
