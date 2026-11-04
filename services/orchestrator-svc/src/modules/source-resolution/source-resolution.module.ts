import { Module } from "@nestjs/common";
import { SourceResolutionService } from "./source-resolution.service.js";
import { StagedSourceReleaseService } from "./staged-source-release.service.js";

@Module({
  providers: [SourceResolutionService, StagedSourceReleaseService],
  exports: [SourceResolutionService, StagedSourceReleaseService],
})
export class SourceResolutionModule {}
