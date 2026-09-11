import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db-query";
import { APP_FILTER } from "@nestjs/core";
import { LegacyHttpExceptionFilter } from "./common/legacy-http-exception.filter.js";
import { NotFoundModule } from "./common/not-found.module.js";
import configuration, { type AppConfigService } from "./config/configuration.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ConfigContractModule } from "./modules/config-contract/config-contract.module.js";
import { AggregationModule } from "./modules/aggregation/aggregation.module.js";
import { ResultsModule } from "./modules/results/results.module.js";
import { VerifiersModule } from "./modules/verifiers/verifiers.module.js";
import { QuerySvcEnvDto } from "./config/env.dto.js";

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
      validate: createEnvValidator(QuerySvcEnvDto, "query-svc"),
    }),
    // Provides the PrismaClient + this package's repositories (TrustedVerifiersRepository, the AB-table
    // AggregationRepository) — replaces main.ts's configureDb() call.
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
    HealthModule,
    ConfigContractModule,
    AggregationModule,
    ResultsModule,
    VerifiersModule,
    // Must stay last — its `*path` route only acts as a fallback for whatever nothing above matched.
    NotFoundModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: LegacyHttpExceptionFilter }],
})
export class AppModule {}
