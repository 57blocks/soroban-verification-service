#!/usr/bin/env node
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ScvsLogger, stderrOnlySink } from "@scvs/core";
import { AppModule } from "./app.module.js";
import { BuilderService } from "./modules/builder/builder.service.js";

/** services/builder's AWS Batch container entrypoint (`docker/builder.Dockerfile`). */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    // `NODE_ENV` gates the Nest logger before the application context (and therefore `ConfigService`) exists —
    // same bootstrap-time exception as the other services' main.ts.
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : new ScvsLogger("builder-bootstrap", { sink: stderrOnlySink }),
  });

  try {
    const builderService = app.get(BuilderService);
    const result = await builderService.run();
    process.stdout.write(`${JSON.stringify(result.line)}\n`);
    process.exitCode = result.exitCode;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  const line = {
    schema: "scvs-builder-entrypoint-result-v1",
    classification: "fatal",
    detail: `Unhandled entrypoint error: ${error instanceof Error ? error.message : String(error)}`,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  process.exitCode = 3;
});
