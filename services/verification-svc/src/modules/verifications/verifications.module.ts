import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { RawArchiveBodyMiddleware } from "../../common/raw-archive-body.middleware.js";
import { LegalModule } from "../legal/legal.module.js";
import { JobsService } from "./jobs.service.js";
import { SubmitService } from "./submit.service.js";
import { UploadsService } from "./uploads.service.js";
import { VerificationsController } from "./verifications.controller.js";

@Module({
  imports: [LegalModule],
  controllers: [VerificationsController],
  providers: [SubmitService, JobsService, UploadsService],
})
export class VerificationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RawArchiveBodyMiddleware).forRoutes({ path: "api/verification/v1/uploads/source", method: RequestMethod.POST });
  }
}
