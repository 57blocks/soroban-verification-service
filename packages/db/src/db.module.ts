import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type OnModuleDestroy,
  type Provider,
} from "@nestjs/common";
import { AbuseControlRepository } from "./abuse-control.repo.js";
import { createPrismaClient, type PrismaClient } from "./client.js";
import { toConnectionString, type DbConnectionInput } from "./connection.js";
import { DB_CONNECTION_INPUT, DB_CONNECTION_STRING, PRISMA_CLIENT } from "./db.tokens.js";
import { DbHealthService } from "./db-health.service.js";
import { EnvironmentsRepository } from "./environments.repo.js";
import { JobEventsService } from "./job-events.js";
import { JobsRepository } from "./jobs.repo.js";
import { RebuildsRepository } from "./rebuilds.repo.js";
import { ReportArchiveUploadsRepository } from "./report-archive-uploads.repo.js";
import { SourceArchiveUploadsRepository } from "./source-archive-uploads.repo.js";
import { UploadsRepository } from "./uploads.repo.js";
import { UploadJobReferencesRepository } from "./upload-job-references.repo.js";

export type DbModuleAsyncOptions = Pick<ModuleMetadata, "imports"> & {
  useFactory: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => DbConnectionInput | Promise<DbConnectionInput>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
};

const REPOSITORIES = [
  DbHealthService,
  JobsRepository,
  RebuildsRepository,
  EnvironmentsRepository,
  UploadsRepository,
  UploadJobReferencesRepository,
  AbuseControlRepository,
  JobEventsService,
  SourceArchiveUploadsRepository,
  ReportArchiveUploadsRepository,
];

@Injectable()
class PrismaClientLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

@Module({})
export class DbModule {
  static forRootAsync(options: DbModuleAsyncOptions): DynamicModule {
    const connectionInputProvider: Provider = {
      provide: DB_CONNECTION_INPUT,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    const connectionStringProvider: Provider = {
      provide: DB_CONNECTION_STRING,
      useFactory: (input: DbConnectionInput) => toConnectionString(input),
      inject: [DB_CONNECTION_INPUT],
    };

    const clientProvider: Provider = {
      provide: PRISMA_CLIENT,
      useFactory: (input: DbConnectionInput) => createPrismaClient(input),
      inject: [DB_CONNECTION_INPUT],
    };

    return {
      module: DbModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        connectionInputProvider,
        connectionStringProvider,
        clientProvider,
        PrismaClientLifecycle,
        ...REPOSITORIES,
      ],
      exports: [PRISMA_CLIENT, DB_CONNECTION_STRING, ...REPOSITORIES],
    };
  }
}
