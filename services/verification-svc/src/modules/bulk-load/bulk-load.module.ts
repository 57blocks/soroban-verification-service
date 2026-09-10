import { Module } from "@nestjs/common";
import { OwnBulkLoadController } from "./own-bulk-load.controller.js";

// JobsRepository comes from the global DbModule (app.module.ts) — no providers of its own.
@Module({
  controllers: [OwnBulkLoadController],
})
export class BulkLoadModule {}
