import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type OnModuleDestroy,
  type Provider,
} from "@nestjs/common";
import { createPrismaClient, type PrismaClient } from "./client.js";
import { toConnectionString, type DbConnectionInput } from "@scvs/db";
import { DB_CONNECTION_STRING, PRISMA_CLIENT } from "./db.tokens.js";
import { DbHealthService } from "./db-health.service.js";
import { TrustedVerifiersRepository } from "./trusted-verifiers.repo.js";
import { AggregationRepository } from "./aggregation.repo.js";

export type DbModuleAsyncOptions = Pick<ModuleMetadata, "imports"> & {
  /**
   * Resolves the connection. query-svc's `config/configuration.ts` reads the `query-postgres` manifest group's
   * variables.
   */
  useFactory: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Nest's own factory typing
    ...args: any[]
  ) => DbConnectionInput | Promise<DbConnectionInput>;
  /** Injection tokens for `useFactory`'s parameters, same contract as Nest's own async options. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  inject?: any[];
};

const REPOSITORIES = [DbHealthService, TrustedVerifiersRepository, AggregationRepository];

/** Owns the lifecycle of the Prisma client created by this module. */
@Injectable()
class PrismaClientLifecycle implements OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Provides this package's `PrismaClient` and its two repositories. */
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
      // Global, like @scvs/db's own DbModule — see that module's header for why.
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
