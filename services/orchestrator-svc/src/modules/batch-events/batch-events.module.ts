import { Module } from "@nestjs/common";
import { BuildEnvironmentsModule } from "../build-environments/build-environments.module.js";
import { BatchEventConsumerService } from "./batch-event-consumer.service.js";
import { BatchEventHandlerService } from "./batch-event-handler.service.js";
import { RebuildOutcomeService } from "./rebuild-outcome.service.js";

/**
 * Both moved: the retry is now a CAS on the rebuild that the ordinary poll loop redispatches, and publication
 * belongs to the job whose verdict resolved.
 */
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
