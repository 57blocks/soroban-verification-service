import { Module } from "@nestjs/common";
import { VerifiersController } from "./verifiers.controller.js";
import { VerifiersService } from "./verifiers.service.js";

@Module({
  controllers: [VerifiersController],
  providers: [VerifiersService],
})
export class VerifiersModule {}
