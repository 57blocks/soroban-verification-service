import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type Provider,
} from "@nestjs/common";
import { DrainState, ScvsLogger } from "@scvs/core";

export const DRAIN_GRACE_MS = Symbol("SCVS_DRAIN_GRACE_MS");

@Injectable()
export class DrainService implements BeforeApplicationShutdown {
  private readonly logger = new ScvsLogger("drain");

  constructor(
    @Inject(DrainState) private readonly state: DrainState,
    @Inject(DRAIN_GRACE_MS) private readonly graceMs: number,
  ) {}

  /** `beforeApplicationShutdown`: Nest runs it before closing the HTTP server, the only window to keep answering. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.state.beginDrain(new Date().toISOString(), this.logger);
    if (this.graceMs <= 0) {
      this.logger.log("drain grace period is zero, shutting down immediately", { signal });
      return;
    }
    this.logger.log("drain grace period started", { signal, grace_ms: this.graceMs });
    await new Promise((resolve) => setTimeout(resolve, this.graceMs));
    this.logger.log("drain grace period elapsed, shutting down", { signal });
  }
}

export type DrainModuleAsyncOptions = {
  imports?: DynamicModule["imports"];
  inject?: Provider[] | unknown[];
  useFactory: (...args: never[]) => number | Promise<number>;
};

@Module({})
export class DrainModule {
  static forRootAsync(options: DrainModuleAsyncOptions): DynamicModule {
    return {
      module: DrainModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: DrainState, useFactory: () => new DrainState() },
        {
          provide: DRAIN_GRACE_MS,
          useFactory: options.useFactory as (...args: unknown[]) => number | Promise<number>,
          inject: (options.inject ?? []) as never[],
        },
        DrainService,
      ],
      exports: [DrainState, DrainService],
    };
  }
}
