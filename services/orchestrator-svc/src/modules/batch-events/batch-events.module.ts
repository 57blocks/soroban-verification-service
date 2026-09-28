import { Module } from "@nestjs/common";
import { BuildEnvironmentsModule } from "../build-environments/build-environments.module.js";
import { BatchEventConsumerService } from "./batch-event-consumer.service.js";
import { BatchEventHandlerService } from "./batch-event-handler.service.js";
import { RebuildOutcomeService } from "./rebuild-outcome.service.js";

@Module({
  imports: [BuildEnvironmentsModule],
  providers: [
    BatchEventConsumerService,
    BatchEventHandlerService,
    RebuildOutcomeService,
  ],
  exports: [RebuildOutcomeService],
})
export class BatchEventsModule {}
