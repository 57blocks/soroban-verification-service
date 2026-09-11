import { Module } from "@nestjs/common";
import { MaterialiseService } from "./materialise.service.js";

/** The socket-less half of the builder. */
@Module({
  providers: [MaterialiseService],
  exports: [MaterialiseService],
})
export class MaterialiseModule {}
