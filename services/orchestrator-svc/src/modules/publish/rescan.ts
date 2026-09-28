import "reflect-metadata";
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: envFilePaths(),
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

const logger = new ScvsLogger("publish-rescan");

export async function publishAllStoredResults(
  publishService: PublishService,
  jobsRepository: JobsRepository,
): Promise<{ scanned: number; published: number; failed: number }> {
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
