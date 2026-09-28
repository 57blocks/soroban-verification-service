import { Module } from "@nestjs/common";
import { BuilderService } from "./builder.service.js";

@Module({
  providers: [BuilderService],
  exports: [BuilderService],
})
export class BuilderModule {}
