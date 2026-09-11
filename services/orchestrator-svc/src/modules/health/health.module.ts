import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";

@Module({
  // No import for the worker's tick: `WorkerTickState` is a global provider precisely so a health route does
  // not have to depend on the module that does the work.
  controllers: [HealthController],
})
export class HealthModule {}
