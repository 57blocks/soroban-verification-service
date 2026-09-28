import { Module } from "@nestjs/common";
import { ComposerService } from "./composer.service.js";

@Module({
  providers: [ComposerService],
  exports: [ComposerService],
})
export class ComposerModule {}
