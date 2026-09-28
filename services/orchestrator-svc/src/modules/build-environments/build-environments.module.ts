import { Module } from "@nestjs/common";
import { BuildEnvironmentMaterializer } from "./build-environment-materializer.js";
import { BuildEnvironmentResolver } from "./build-environment-resolver.js";
import { CachingBuildEnvironmentMaterializer } from "./caching-build-environment-materializer.service.js";
import { ComposerDispatchService } from "./composer-dispatch.service.js";
import { DeterministicBuildEnvironmentResolver } from "./deterministic-build-environment-resolver.service.js";
import { EnvironmentOutcomeService } from "./environment-outcome.service.js";

@Module({
  providers: [
    { provide: BuildEnvironmentResolver, useClass: DeterministicBuildEnvironmentResolver },
    { provide: BuildEnvironmentMaterializer, useClass: CachingBuildEnvironmentMaterializer },
    ComposerDispatchService,
    EnvironmentOutcomeService,
  ],
  exports: [
    BuildEnvironmentResolver,
    BuildEnvironmentMaterializer,
    ComposerDispatchService,
    EnvironmentOutcomeService,
  ],
})
export class BuildEnvironmentsModule {}
