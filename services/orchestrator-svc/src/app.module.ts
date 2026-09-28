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
      envFilePath: envFilePaths(),
      validate: createEnvValidator(OrchestratorSvcEnvDto, "orchestrator-svc"),
    }),
    DbModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("postgres", { infer: true }),
    }),
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
