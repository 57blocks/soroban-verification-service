import { Module } from "@nestjs/common";
import { SourceResolutionService } from "./source-resolution.service.js";

@Module({
  providers: [SourceResolutionService],
  exports: [SourceResolutionService],
})
export class SourceResolutionModule {}
