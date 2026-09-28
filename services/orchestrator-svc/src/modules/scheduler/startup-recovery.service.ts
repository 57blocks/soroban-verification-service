import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ScvsLogger } from "@scvs/core";
import { BatchDispatchService } from "../verification-pipeline/index.js";

@Injectable()
export class StartupRecoveryService implements OnModuleInit {
  private readonly logger = new ScvsLogger("startup-recovery");

  constructor(
    @Inject(BatchDispatchService)
    private readonly batchDispatch: BatchDispatchService
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log("starting up, recovering interrupted jobs...");
    const recovery = await this.batchDispatch.recoverJobsOnStartup();
    this.logger.log("recovery complete", {
      queued: recovery.queued,
      reset_rebuilds: recovery.reset_rebuilds,
    });
  }
}
