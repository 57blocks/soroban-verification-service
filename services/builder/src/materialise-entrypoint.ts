#!/usr/bin/env node
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ScvsLogger, stderrOnlySink } from "@scvs/core";
import { MaterialiseAppModule } from "./materialise-app.module.js";
import { MaterialiseService } from "./modules/materialise/materialise.service.js";

/**
 * Registered as the first container of the Batch job definition's `ecsProperties.taskProperties`, with **no
 * `docker.sock` mount**; the runner depends on it with `condition: "SUCCESS"`.
 */
async function main(): Promise<void> {
  const logger = new ScvsLogger("materialise-bootstrap", { sink: stderrOnlySink });
  const app = await NestFactory.createApplicationContext(MaterialiseAppModule, {
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });
  try {
    process.exitCode = await app.get(MaterialiseService).run();
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // A crash, which is the one case that should stop the runner: there is no handoff to read, and the runner
  // reports that as `fatal` rather than blaming the submission.
  new ScvsLogger("materialise-bootstrap", { sink: stderrOnlySink }).error(
    "unhandled materialiser error",
    { error: error instanceof Error ? error : String(error) },
  );
  process.exitCode = 3;
});
