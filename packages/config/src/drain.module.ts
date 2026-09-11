import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type Provider,
} from "@nestjs/common";
import { DrainState, ScvsLogger } from "@scvs/core";

/** The graceful-shutdown half of O9's draining runbook, as a Nest provider. */
export const DRAIN_GRACE_MS = Symbol("SCVS_DRAIN_GRACE_MS");

@Injectable()
export class DrainService implements BeforeApplicationShutdown {
  private readonly logger = new ScvsLogger("drain");

  constructor(
    @Inject(DrainState) private readonly state: DrainState,
    @Inject(DRAIN_GRACE_MS) private readonly graceMs: number,
  ) {}

  /**
   * `beforeApplicationShutdown` rather than `onApplicationShutdown`: Nest runs this **before** it closes the
   * HTTP server, which is the only window in which "keep answering while deregistering" is possible at all.
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.state.beginDrain(new Date().toISOString(), this.logger);
    if (this.graceMs <= 0) {
      // A legitimate setting, not only a test one: a deployment with nothing in front of it has no
      // deregistration to wait for.
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
  /** Returns the grace period in ms — each service reads `SCVS_DRAIN_GRACE_MS` through its own `ConfigService`. */
  useFactory: (...args: never[]) => number | Promise<number>;
};

@Module({})
export class DrainModule {
  /**
   * Async so the grace period arrives through the service's own `ConfigService` rather than from `process.env`
   * read inside a package — AGENTS.md's rule.
   */
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
