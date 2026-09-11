import { Module } from "@nestjs/common";
import { SoveClientFactory } from "../results/client-factory.service.js";
import { AggregationReadService } from "./aggregation-read.service.js";
import { AggregationSyncService } from "./aggregation-sync.service.js";
import { BulkLoadController } from "./bulk-load.controller.js";

@Module({
  controllers: [BulkLoadController],
  providers: [AggregationReadService, AggregationSyncService, SoveClientFactory],
  exports: [AggregationReadService, AggregationSyncService, SoveClientFactory],
})
export class AggregationModule {}
