import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db";
import { BatchEventsModule } from "./modules/batch-events/batch-events.module.js";
import configuration, { type AppConfigService } from "./config/configuration.js";
import { WorkerTickModule } from "./common/worker-tick.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ConfigContractModule } from "./modules/config-contract/config-contract.module.js";
import { PublishModule } from "./modules/publish/publish.module.js";
import { SchedulerModule } from "./modules/scheduler/scheduler.module.js";
import { VerificationPipelineModule } from "./modules/verification-pipeline/verification-pipeline.module.js";
import { OrchestratorSvcEnvDto } from "./config/env.dto.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Without this, ConfigModule reads only `<cwd>/.env` — the reason the same POSTGRES_* block had to exist
      // in every service directory.
      envFilePath: envFilePaths(),
      // Runs BEFORE the `load` factory below, so a malformed variable is reported ahead of any single-variable
      // throw inside configuration.ts.
      validate: createEnvValidator(OrchestratorSvcEnvDto, "orchestrator-svc"),
    }),
    // Provides the PrismaClient + every repository.
    DbModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("postgres", { infer: true }),
    }),
    // Global, so the health controller and the dispatch scheduler share one DrainState — the probe must report
    // the same drain the scheduler is honouring.
    DrainModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("drainGraceMs", { infer: true }),
    }),
    WorkerTickModule,
    VerificationPipelineModule,
    PublishModule,
    SchedulerModule,
    BatchEventsModule,
    HealthModule,
    ConfigContractModule,
  ],
})
export class AppModule {}
