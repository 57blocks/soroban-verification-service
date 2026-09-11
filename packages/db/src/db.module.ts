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
import { DB_CONNECTION_STRING, PRISMA_CLIENT } from "./db.tokens.js";
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
  /** Resolves the connection. */
  useFactory: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Nest's own factory typing
    ...args: any[]
  ) => DbConnectionInput | Promise<DbConnectionInput>;
  /** Injection tokens for `useFactory`'s parameters, same contract as Nest's own async options. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  inject?: any[];
};

const REPOSITORIES = [
  // Not a repository, but provided and exported on the same terms: it is the readiness probe's `SELECT 1`, and
  // it keeps `$queryRaw` inside this package.
  DbHealthService,
  JobsRepository,
  RebuildsRepository,
  // See environments.repo.ts's own header.
  EnvironmentsRepository,
  UploadsRepository,
  UploadJobReferencesRepository,
  AbuseControlRepository,
  JobEventsService,
  SourceArchiveUploadsRepository,
  ReportArchiveUploadsRepository,
];

/** Owns the lifecycle of the Prisma client created by this module. */
@Injectable()
class PrismaClientLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Provides the `PrismaClient` and every repository over it. */
@Module({})
export class DbModule {
  static forRootAsync(options: DbModuleAsyncOptions): DynamicModule {
    const connectionStringProvider: Provider = {
      provide: DB_CONNECTION_STRING,
      useFactory: async (...args: unknown[]) =>
        toConnectionString(await options.useFactory(...args)),
      inject: options.inject ?? [],
    };

    const clientProvider: Provider = {
      provide: PRISMA_CLIENT,
      useFactory: (url: string) => createPrismaClient({ url }),
      inject: [DB_CONNECTION_STRING],
    };

    return {
      module: DbModule,
      // Global, like `ConfigModule.forRoot({ isGlobal: true })` next to it in every app.module.ts.
      global: true,
      imports: options.imports ?? [],
      providers: [
        connectionStringProvider,
        clientProvider,
        PrismaClientLifecycle,
        ...REPOSITORIES,
      ],
      exports: [PRISMA_CLIENT, DB_CONNECTION_STRING, ...REPOSITORIES],
    };
  }
}
