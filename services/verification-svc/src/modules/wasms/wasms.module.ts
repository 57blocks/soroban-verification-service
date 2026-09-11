import { Module } from "@nestjs/common";
import { WasmsController } from "./wasms.controller.js";
import { WasmsService } from "./wasms.service.js";

@Module({
  controllers: [WasmsController],
  providers: [WasmsService],
})
export class WasmsModule {}
