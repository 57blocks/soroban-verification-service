import { Module } from "@nestjs/common";
import { PreflightController } from "./preflight.controller.js";
import { PreflightService } from "./preflight.service.js";

@Module({
  controllers: [PreflightController],
  providers: [PreflightService],
})
export class PreflightModule {}
