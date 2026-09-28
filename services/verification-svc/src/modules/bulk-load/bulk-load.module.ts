import { Module } from "@nestjs/common";
import { OwnBulkLoadController } from "./own-bulk-load.controller.js";

@Module({
  controllers: [OwnBulkLoadController],
})
export class BulkLoadModule {}
