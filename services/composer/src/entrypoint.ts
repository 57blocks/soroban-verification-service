#!/usr/bin/env node
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ScvsLogger, stderrOnlySink } from "@scvs/core";
import { AppModule } from "./app.module.js";
import { ComposerService } from "./modules/composer/composer.service.js";

/** `services/composer`'s AWS Batch container entrypoint (`docker/composer.Dockerfile`). */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : new ScvsLogger("composer-bootstrap", { sink: stderrOnlySink }),
  });

  try {
    const result = await app.get(ComposerService).run();
    process.stdout.write(`${JSON.stringify(result.line)}\n`);
    process.exitCode = result.exitCode;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  const line = {
    schema: "scvs-composer-artifact-v1",
    classification: "composition_failure",
    reason: "composer_entrypoint_error",
    detail: `Unhandled entrypoint error: ${error instanceof Error ? error.message : String(error)}`,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  process.exitCode = 3;
});
