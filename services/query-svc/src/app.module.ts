import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db-query";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";

import { NotFoundModule } from "./common/not-found.module.js";
import configuration, { type AppConfigService } from "./config/configuration.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ConfigContractModule } from "./modules/config-contract/config-contract.module.js";
import { AggregationModule } from "./modules/aggregation/aggregation.module.js";
import { ResultsModule } from "./modules/results/results.module.js";
import { VerifiersModule } from "./modules/verifiers/verifiers.module.js";
import { QuerySvcEnvDto } from "./config/env.dto.js";
import { FixedWindowThrottlerStorage, LegacyHttpExceptionFilter, RateLimitGuard } from "@scvs/http";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: envFilePaths(),
      validate: createEnvValidator(QuerySvcEnvDto, "query-svc"),
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
    ThrottlerModule.forRootAsync({
      // Throttler's options type cannot resolve Nest 12's interfaces, which makes `imports` required.
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: configService.get("queryThrottleLimit", { infer: true }) }],
        storage: new FixedWindowThrottlerStorage(),
      }),
    }),
    HealthModule,
    ConfigContractModule,
    AggregationModule,
    ResultsModule,
    VerifiersModule,
    // Must stay last: its `*path` route is the fallback for whatever nothing above matched.
    NotFoundModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: LegacyHttpExceptionFilter },
  ],
})
export class AppModule {}
