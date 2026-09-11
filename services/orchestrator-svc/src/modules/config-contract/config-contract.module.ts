import { Module } from "@nestjs/common";
import { ConfigContractController } from "./config-contract.controller.js";

@Module({
  controllers: [ConfigContractController],
})
export class ConfigContractModule {}
