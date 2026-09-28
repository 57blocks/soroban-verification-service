import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPinnedFetch } from "@scvs/core/pinned-fetch";
import { SoveClientFactory } from "../results/client-factory.service.js";
import { RESULT_FETCH_FACTORY, type ResultFetchFactory } from "../results/result-fetch-factory.js";
import type { AppConfigService } from "../../config/configuration.js";
import { AggregationReadService } from "./aggregation-read.service.js";
import { AggregationSyncService } from "./aggregation-sync.service.js";
import { BulkLoadController } from "./bulk-load.controller.js";

@Module({
  controllers: [BulkLoadController],
  providers: [
    AggregationReadService,
    AggregationSyncService,
    SoveClientFactory,
    {
      provide: RESULT_FETCH_FACTORY,
      inject: [ConfigService],
      useFactory: (configService: AppConfigService): ResultFetchFactory =>
        configService.get("pinDnsResolution", { infer: true })
          ? (policy) => createPinnedFetch(policy)
          : () => globalThis.fetch,
    },
  ],
  exports: [AggregationReadService, AggregationSyncService, SoveClientFactory],
})
export class AggregationModule {}
