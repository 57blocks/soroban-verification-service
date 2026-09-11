import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { V1HealthController } from "./v1-health.controller.js";

@Module({
  controllers: [HealthController, V1HealthController],
})
export class HealthModule {}
