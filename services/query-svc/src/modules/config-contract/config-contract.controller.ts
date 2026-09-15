import { Controller, Get } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { reportConfigContract, type ConfigContractReport } from "@scvs/config";

/** Three things about this controller are load-bearing: */
// Read by deployment tooling, not by the public: throttling it would make a configuration audit fail for
// reasons that have nothing to do with the configuration.
@SkipThrottle()
@ApiExcludeController()
@Controller("internal/config-contract")
export class ConfigContractController {
  @Get()
  getConfigContract(): ConfigContractReport {
    return reportConfigContract("query-svc");
  }
}
