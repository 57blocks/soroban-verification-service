import { Module } from "@nestjs/common";
import { SourceResolutionModule } from "../source-resolution/source-resolution.module.js";
import { ArweaveArchiveService } from "./arweave-archive.service.js";
import { PublishService } from "./publish.service.js";
import { VerifierIdentityPublisher } from "./verifier-identity-publisher.service.js";

@Module({
  imports: [SourceResolutionModule],
  providers: [ArweaveArchiveService, PublishService, VerifierIdentityPublisher],
  exports: [PublishService, ArweaveArchiveService],
})
export class PublishModule {}
