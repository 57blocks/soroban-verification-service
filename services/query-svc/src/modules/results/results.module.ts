import { Module } from "@nestjs/common";
import { AggregationModule } from "../aggregation/aggregation.module.js";
import { ADDRESS_RESOLVER } from "./address-resolver.js";
import { ResultsController } from "./results.controller.js";
import { StellarRpcAddressResolver } from "./stellar-rpc.resolver.js";

@Module({
  imports: [AggregationModule],
  controllers: [ResultsController],
  providers: [{ provide: ADDRESS_RESOLVER, useClass: StellarRpcAddressResolver }],
})
export class ResultsModule {}
