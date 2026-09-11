import { Global, Injectable, Module } from "@nestjs/common";

/** What the dispatch scheduler last observed, so `/health/ready` can report the queue without running a query. */
@Injectable()
export class WorkerTickState {
  private last: { queueDepth: number; inFlight: number; at: string } | undefined;

  record(tick: { queueDepth: number; inFlight: number; at: string }): void {
    this.last = tick;
  }

  /** `undefined` until the first tick completes. */
  get tick(): { queueDepth: number; inFlight: number; at: string } | undefined {
    return this.last;
  }
}

@Global()
@Module({
  providers: [WorkerTickState],
  exports: [WorkerTickState],
})
export class WorkerTickModule {}
