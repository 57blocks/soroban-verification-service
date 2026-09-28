import { Module } from "@nestjs/common";
import { BuildEnvironmentsModule } from "../build-environments/build-environments.module.js";
import { PublishModule } from "../publish/publish.module.js";
import { SourceResolutionModule } from "../source-resolution/source-resolution.module.js";
import { BatchDispatchService } from "./batch-dispatch.service.js";
import { BuildEnvironmentIdentityService } from "./build-environment-identity.service.js";
import { ChainReaderService } from "./chain-reader.service.js";
import { ImagePlatformService } from "./image-platform.service.js";
import { MismatchDiagnosticsService } from "./mismatch-diagnostics.service.js";
import { VerificationPipelineService } from "./verification-pipeline.service.js";

@Module({
  imports: [PublishModule, BuildEnvironmentsModule, SourceResolutionModule],
  providers: [
    ChainReaderService,
    BuildEnvironmentIdentityService,
    // Not exported: its per-process cache is sound only with exactly one instance.
    ImagePlatformService,
    BatchDispatchService,
    MismatchDiagnosticsService,
    VerificationPipelineService,
  ],
  exports: [
    VerificationPipelineService,
    BatchDispatchService,
  ],
})
export class VerificationPipelineModule {}
