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

/**
 * The build-dispatch half of orchestrator-svc's pipeline. Exports `VerificationPipelineService` (driven per
 * active job by `build-dispatch.scheduler.ts`) and `BatchDispatchService`.
 */
@Module({
  imports: [PublishModule, BuildEnvironmentsModule, SourceResolutionModule],
  providers: [
    ChainReaderService,
    // Not exported: it answers a question only the pipeline asks, about a rebuild only the pipeline keys.
    BuildEnvironmentIdentityService,
    // Not exported: `BatchDispatchService` is its only consumer, and its per-process cache is only sound
    // because there is exactly one instance of it.
    ImagePlatformService,
    BatchDispatchService,
    // Not exported: only `VerificationPipelineService` explains a mismatch, and it does so strictly after the
    // verdict it cannot change.
    MismatchDiagnosticsService,
    VerificationPipelineService,
  ],
  exports: [
    VerificationPipelineService,
    BatchDispatchService,
  ],
})
export class VerificationPipelineModule {}
