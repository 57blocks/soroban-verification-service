import "reflect-metadata";
// Same side-effect import, and for the same reason, as rescan.ts/main.ts — this is a second entrypoint into the
// same DI graph, and it reads the jobs table.
import "@scvs/config/load-env";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { createEnvValidator, envFilePaths } from "@scvs/config";
import { NestFactory } from "@nestjs/core";
import { ScvsLogger } from "@scvs/core";
import { DbModule, JobsRepository, type JobRecord } from "@scvs/db";
import configuration, { type AppConfigService } from "../../config/configuration.js";
import { ArweaveArchiveService } from "./arweave-archive.service.js";
import { PublishModule } from "./publish.module.js";
import { OrchestratorSvcEnvDto } from "../../config/env.dto.js";

/** Minimal module for the one-shot archive-backfill CLI. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: envFilePaths(),
      // Runs BEFORE the `load` factory below, so a malformed variable is reported ahead of any single-variable
      // throw inside configuration.ts.
      validate: createEnvValidator(OrchestratorSvcEnvDto, "orchestrator-svc (archive-once)"),
    }),
    DbModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) =>
        configService.get("postgres", { infer: true }),
    }),
    PublishModule,
  ],
})
class ArchiveOnceModule {}

/**
 * One-shot CLI entrypoint (`pnpm --filter @scvs/orchestrator-svc run archive-once`): retries every job with an
 * outstanding archive obligation exactly once each, reports how many succeeded, and exits.
 */
// A module-level logger: this file is a one-shot CLI entrypoint plus a free function, not a provider.
const logger = new ScvsLogger("archive-once");

export async function retryAllPendingArchives(
  arweaveArchive: ArweaveArchiveService,
  jobsRepository: JobsRepository,
): Promise<{ scanned: number; archived: number; stillPending: number }> {
  const pending = await jobsRepository.listJobsPendingArchive();

  for (const job of pending) {
    try {
      await arweaveArchive.retryPendingArchive(job);
    } catch (error) {
      logger.error("archive-once: failed to retry job", {
        job_id: job.jobId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  // Re-read rather than trust the in-memory outcome of each retryPendingArchive call: a job that found an
  // existing upload or hit insufficient_balance is still correctly reflected only by reading
  // archivePendingSince back from the row, the same durable state the reconciliation scan itself trusts (AP4).
  const remaining = await jobsRepository.listJobsPendingArchive();
  const remainingIds = new Set(remaining.map((job: JobRecord) => job.jobId));
  return {
    scanned: pending.length,
    archived: pending.filter((job) => !remainingIds.has(job.jobId)).length,
    stillPending: remaining.length,
  };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ArchiveOnceModule, {
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });
  try {
    const arweaveArchive = app.get(ArweaveArchiveService);
    const jobsRepository = app.get(JobsRepository);
    const summary = await retryAllPendingArchives(arweaveArchive, jobsRepository);
    logger.log("archive-once complete", {
      scanned: summary.scanned,
      archived: summary.archived,
      still_pending: summary.stillPending,
    });
    if (summary.stillPending > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

await main();
