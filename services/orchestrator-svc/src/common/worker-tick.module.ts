import { Global, Injectable, Module } from "@nestjs/common";

@Injectable()
export class WorkerTickState {
  private last: { queueDepth: number; inFlight: number; at: string } | undefined;

  record(tick: { queueDepth: number; inFlight: number; at: string }): void {
    this.last = tick;
  }

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
