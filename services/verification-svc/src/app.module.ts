import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AbuseGuardModule } from "./common/abuse-guard.module.js";

import { NotFoundModule } from "./common/not-found.module.js";
import { RequestIdMiddleware } from "./common/request-id.middleware.js";
import configuration, { type AppConfigService } from "./config/configuration.js";
import { HealthModule } from "./modules/health/health.module.js";
import { BulkLoadModule } from "./modules/bulk-load/bulk-load.module.js";
import { ConfigContractModule } from "./modules/config-contract/config-contract.module.js";
import { LegalModule } from "./modules/legal/legal.module.js";
import { PreflightModule } from "./modules/preflight/preflight.module.js";
import { AbuseControlSweepModule } from "./modules/abuse-control-sweep/abuse-control-sweep.module.js";
import { UploadCleanupModule } from "./modules/upload-cleanup/upload-cleanup.module.js";
import { VerificationsModule } from "./modules/verifications/verifications.module.js";
import { WasmsModule } from "./modules/wasms/wasms.module.js";
import { VerificationSvcEnvDto } from "./config/env.dto.js";
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
      validate: createEnvValidator(VerificationSvcEnvDto, "verification-svc"),
    }),
    // Provides the PrismaClient + every repository.
    DbModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("postgres", { infer: true }),
    }),
    // Global, so the health controller and the submission guard share one DrainState — two instances would mean
    // a process that is draining according to one of them and not the other.
    DrainModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("drainGraceMs", { infer: true }),
    }),
    // Global for the same reason as DrainModule above — see abuse-guard.module.ts.
    AbuseGuardModule,
    // The cheap in-process tier in front of the Postgres-backed `AbuseGuard`.
    ThrottlerModule.forRootAsync({
      // Throttler 6.7's options type cannot resolve Nest 12's `@nestjs/common/interfaces`, which makes `imports` required.
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) => [
        { ttl: 60_000, limit: configService.get("throttleLimit", { infer: true }) },
      ],
    }),
    ScheduleModule.forRoot(),
    HealthModule,
    ConfigContractModule,
    LegalModule,
    PreflightModule,
    VerificationsModule,
    UploadCleanupModule,
    AbuseControlSweepModule,
    BulkLoadModule,
    WasmsModule,
    // Must stay last — its `*path` route only acts as a fallback for whatever nothing above matched.
    NotFoundModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: LegacyHttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  // Every route, including `/health` and the SSE stream: O2's identifier has to exist for the request legs that
  // precede a job, and a middleware applied selectively would leave gaps that only show up as a missing field
  // months later.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*path");
  }
}
