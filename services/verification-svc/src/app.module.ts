import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { DrainModule, createEnvValidator, envFilePaths } from "@scvs/config";
import { DbModule } from "@scvs/db";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
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
import { FixedWindowThrottlerStorage, LegacyHttpExceptionFilter, RateLimitGuard } from "@scvs/http";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: envFilePaths(),
      validate: createEnvValidator(VerificationSvcEnvDto, "verification-svc"),
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
    AbuseGuardModule,
    ThrottlerModule.forRootAsync({
      // Throttler 6.7's options type cannot resolve Nest 12's `@nestjs/common/interfaces`, which makes `imports` required.
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: configService.get("throttleLimit", { infer: true }) }],
        storage: new FixedWindowThrottlerStorage(),
      }),
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
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: LegacyHttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*path");
  }
}
