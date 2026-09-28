import { Module } from "@nestjs/common";
import { MaterialiseService } from "./materialise.service.js";

@Module({
  providers: [MaterialiseService],
  exports: [MaterialiseService],
})
export class MaterialiseModule {}
