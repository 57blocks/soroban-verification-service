import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db-query";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";

import { FixedWindowThrottlerStorage } from "./common/fixed-window-throttler.storage.js";
import { RateLimitGuard } from "./common/rate-limit.guard.js";
import { NotFoundModule } from "./common/not-found.module.js";
import configuration, { type AppConfigService } from "./config/configuration.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ConfigContractModule } from "./modules/config-contract/config-contract.module.js";
import { AggregationModule } from "./modules/aggregation/aggregation.module.js";
import { ResultsModule } from "./modules/results/results.module.js";
import { VerifiersModule } from "./modules/verifiers/verifiers.module.js";
import { QuerySvcEnvDto } from "./config/env.dto.js";
import { LegacyHttpExceptionFilter } from "@scvs/http";

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
    // The read surface's only entry control, this service having no account to bound instead. The counter is
    // per (caller, route handler), not one bucket per caller, so each route carries this ceiling
    // independently — which is what keeps the tight address tier out of reach of traffic to any other route.
    ThrottlerModule.forRootAsync({
      // Throttler 6.7's options type cannot resolve Nest 12's `@nestjs/common/interfaces`, which makes `imports` required.
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: configService.get("queryThrottleLimit", { infer: true }) }],
        // Not the bundled storage — see fixed-window-throttler.storage.ts for the cross-caller defect that
        // one carries. Constructed here rather than provided, so `main.ts` can hand the same instance to the
        // middleware guarding the routes Swagger mounts outside the guard chain.
        storage: new FixedWindowThrottlerStorage(),
      }),
    }),
    HealthModule,
    ConfigContractModule,
    AggregationModule,
    ResultsModule,
    VerifiersModule,
    // Must stay last — its `*path` route only acts as a fallback for whatever nothing above matched.
    NotFoundModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: LegacyHttpExceptionFilter },
  ],
})
export class AppModule {}
