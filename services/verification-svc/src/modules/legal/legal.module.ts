import { Module } from "@nestjs/common";
import { LegalController } from "./legal.controller.js";
import { LegalService } from "./legal.service.js";

/** Exports the service because the submit path needs it too (versioned-terms-and-assent design.md TA-2). */
@Module({
  controllers: [LegalController],
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
