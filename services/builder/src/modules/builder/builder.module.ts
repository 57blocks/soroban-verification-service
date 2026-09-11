import { Module } from "@nestjs/common";
import { BuilderService } from "./builder.service.js";

/** The Builder's single feature module. */
@Module({
  providers: [BuilderService],
  exports: [BuilderService],
})
export class BuilderModule {}
