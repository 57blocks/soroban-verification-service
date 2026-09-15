import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { RawArchiveBodyMiddleware } from "../../common/raw-archive-body.middleware.js";
import { LegalModule } from "../legal/legal.module.js";
import { JobsService } from "./jobs.service.js";
import { SubmitService } from "./submit.service.js";
import { UploadsService } from "./uploads.service.js";
import { VerificationsController } from "./verifications.controller.js";

@Module({
  // The submit path needs the loaded terms bundle to validate acceptance against (design.md TA-2).
  imports: [LegalModule],
  controllers: [VerificationsController],
  // AbuseGuardService comes from the global AbuseGuardModule (app.module.ts) — see its own header.
  providers: [SubmitService, JobsService, UploadsService],
})
export class VerificationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Uploads are binary tarballs, not JSON.
    consumer.apply(RawArchiveBodyMiddleware).forRoutes({ path: "api/verification/v1/uploads/source", method: RequestMethod.POST });
  }
}
