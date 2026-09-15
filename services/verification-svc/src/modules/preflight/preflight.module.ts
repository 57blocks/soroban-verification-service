import { Module } from "@nestjs/common";
import { PreflightController } from "./preflight.controller.js";
import { PreflightService } from "./preflight.service.js";

@Module({
  controllers: [PreflightController],
  // AbuseGuardService comes from the global AbuseGuardModule (app.module.ts) — see its own header.
  providers: [PreflightService],
})
export class PreflightModule {}
