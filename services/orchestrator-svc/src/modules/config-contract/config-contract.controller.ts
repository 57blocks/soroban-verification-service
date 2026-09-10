import { Controller, Get } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { reportConfigContract, type ConfigContractReport } from "@scvs/config";

/** Three things about this controller are load-bearing: */
@ApiExcludeController()
@Controller("internal/config-contract")
export class ConfigContractController {
  @Get()
  getConfigContract(): ConfigContractReport {
    return reportConfigContract("orchestrator-svc");
  }
}
