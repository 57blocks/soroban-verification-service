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
      // Pinned by default. `pinDnsResolution: false` (SCVS_QUERY_PIN_DNS_RESOLUTION) is the escape hatch a
      // test double needs — the pinned transport bypasses `globalThis.fetch` by design (that bypass is what
      // lets it see the real DNS answer), so anything that replaces `globalThis.fetch` to stand in for a peer
      // needs this off to be seen at all. Production has no reason to ever set it.
      useFactory: (configService: AppConfigService): ResultFetchFactory =>
        configService.get("pinDnsResolution", { infer: true })
          ? (policy) => createPinnedFetch(policy)
          : () => globalThis.fetch,
    },
  ],
  exports: [AggregationReadService, AggregationSyncService, SoveClientFactory],
})
export class AggregationModule {}
