import { Module } from "@nestjs/common";
import { SourceResolutionService } from "./source-resolution.service.js";

/**
 * Both `PublishModule` and `VerificationPipelineModule` import this module instead; neither imports the other's
 * directory.
 */
@Module({
  providers: [SourceResolutionService],
  exports: [SourceResolutionService],
})
export class SourceResolutionModule {}
