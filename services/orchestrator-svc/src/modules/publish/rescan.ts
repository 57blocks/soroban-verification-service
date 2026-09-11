import "reflect-metadata";
// Same side-effect import, and for the same reason, as main.ts — this is a second entrypoint into the same DI
// graph, and it reads the jobs table.
import "@scvs/config/load-env";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { createEnvValidator, envFilePaths } from "@scvs/config";
import { NestFactory } from "@nestjs/core";
import { ScvsLogger } from "@scvs/core";
import { DbModule, JobsRepository } from "@scvs/db";
import configuration, { type AppConfigService } from "../../config/configuration.js";
import { PublishModule } from "./publish.module.js";
import { PublishService } from "./publish.service.js";
import { OrchestratorSvcEnvDto } from "../../config/env.dto.js";

/** Minimal module for the one-shot rescan CLI. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: envFilePaths(),
      // Runs BEFORE the `load` factory below, so a malformed variable is reported ahead of any single-variable
      // throw inside configuration.ts.
      validate: createEnvValidator(OrchestratorSvcEnvDto, "orchestrator-svc (rescan)"),
    }),
    DbModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("postgres", { infer: true }),
    }),
    PublishModule,
  ],
})
class RescanModule {}

/**
 * Distinct from `main.ts`, which drives the primary hand-off path (batch-events publishing as soon as a build's
 * terminal event arrives, backstopped by a low-frequency recovery scan).
 */
// A module-level logger: this file is a one-shot CLI entrypoint plus a free function, not a provider
// (AGENTS.md's rule for stateless helpers).
const logger = new ScvsLogger("publish-rescan");

export async function publishAllStoredResults(
  publishService: PublishService,
  jobsRepository: JobsRepository,
): Promise<{ scanned: number; published: number; failed: number }> {
  // Only jobs whose comparison actually produced a verdict.
  const jobs = await jobsRepository.listJobsByStatus(["published"]);
  const candidates = jobs.filter((job) => job.result?.matched !== undefined && job.manifest);

  let published = 0;
  let failed = 0;
  for (const job of candidates) {
    try {
      await publishService.republishStoredResult(job.jobId);
      published += 1;
    } catch (error) {
      failed += 1;
      logger.error("failed to republish job", {
        job_id: job.jobId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
  return { scanned: candidates.length, published, failed };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RescanModule, {
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });
  try {
    const publishService = app.get(PublishService);
    const summary = await publishAllStoredResults(
      publishService,
      app.get(JobsRepository),
    );
    logger.log("rescan complete", {
      scanned: summary.scanned,
      published: summary.published,
      failed: summary.failed,
    });
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

await main();
