import { Global, Module } from "@nestjs/common";
import { AbuseGuardService } from "./abuse-guard.js";

@Global()
@Module({
  providers: [AbuseGuardService],
  exports: [AbuseGuardService],
})
export class AbuseGuardModule {}
