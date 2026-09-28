import { Module } from "@nestjs/common";
import { LegalController } from "./legal.controller.js";
import { LegalService } from "./legal.service.js";

@Module({
  controllers: [LegalController],
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
