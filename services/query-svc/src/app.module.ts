import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db-query";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { LegacyHttpExceptionFilter } from "./common/legacy-http-exception.filter.js";
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
    // The read surface's only entry control: this service is public and unauthenticated, so the quota is what
    // stands in for the account it does not have.
    //
    // The counter `ThrottlerGuard` keys is per (caller, route handler), not one shared bucket per caller — so
    // this is a ceiling each route carries independently, and a caller working several routes at once is
    // bounded by the sum rather than by this number. That is the behaviour the tight address tier depends on:
    // its budget cannot be spent, or widened, by traffic to any other route.
    ThrottlerModule.forRootAsync({
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
