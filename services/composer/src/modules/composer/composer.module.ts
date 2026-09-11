import { Module } from "@nestjs/common";
import { ComposerService } from "./composer.service.js";

/**
 * The whole of `services/composer`. One provider, no controllers, no scheduler — this is a one-shot AWS Batch
 * container, not a resident service (see `entrypoint.ts`).
 */
@Module({
  providers: [ComposerService],
  exports: [ComposerService],
})
export class ComposerModule {}
