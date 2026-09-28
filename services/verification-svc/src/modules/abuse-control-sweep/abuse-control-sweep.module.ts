import { Module } from "@nestjs/common";
import { AbuseControlSweepScheduler } from "./abuse-control-sweep.scheduler.js";

@Module({
  providers: [AbuseControlSweepScheduler],
})
export class AbuseControlSweepModule {}
