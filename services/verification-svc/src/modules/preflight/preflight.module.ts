import { Module } from "@nestjs/common";
import { AbuseGuardService } from "../../common/abuse-guard.js";
import { PreflightController } from "./preflight.controller.js";
import { PreflightService } from "./preflight.service.js";

@Module({
  controllers: [PreflightController],
  // See verifications.module.ts for why AbuseGuardService is listed per-module.
  providers: [PreflightService, AbuseGuardService],
})
export class PreflightModule {}
