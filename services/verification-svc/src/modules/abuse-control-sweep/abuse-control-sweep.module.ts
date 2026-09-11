import { Module } from "@nestjs/common";
import { AbuseControlSweepScheduler } from "./abuse-control-sweep.scheduler.js";

// AbuseControlRepository comes from the global DbModule (app.module.ts) — no providers of its own beyond the
// scheduler.
@Module({
  providers: [AbuseControlSweepScheduler],
})
export class AbuseControlSweepModule {}
