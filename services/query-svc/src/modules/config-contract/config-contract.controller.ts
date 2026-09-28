import { Controller, Get } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { reportConfigContract, type ConfigContractReport } from "@scvs/config";

@SkipThrottle()
@ApiExcludeController()
@Controller("internal/config-contract")
export class ConfigContractController {
  @Get()
  getConfigContract(): ConfigContractReport {
    return reportConfigContract("query-svc");
  }
}
