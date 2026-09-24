import { jest } from "@jest/globals";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { AbuseControlRepository, DbModule, PRISMA_CLIENT, type PrismaClient } from "@scvs/db";
import { UploadCleanupService } from "../src/common/upload-cleanup.js";
import configuration, { type AppConfigService } from "../src/config/configuration.js";
import { AbuseControlSweepModule } from "../src/modules/abuse-control-sweep/abuse-control-sweep.module.js";
import { UploadCleanupModule } from "../src/modules/upload-cleanup/upload-cleanup.module.js";

/** A sweep an interval started must land before closing the app disconnects the database under it. */

const EVERY_MS = 5;

type Sweep = "upload-cleanup" | "abuse-control-sweep";

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [() => ({ ...configuration(), uploadCleanupIntervalMs: EVERY_MS, abuseSweepIntervalMs: EVERY_MS })],
      }),
      ScheduleModule.forRoot(),
      DbModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (configService: AppConfigService) => configService.get("postgres", { infer: true }),
      }),
      UploadCleanupModule,
      AbuseControlSweepModule,
    ],
  }).compile();
}

/** A promise the test opens by hand, so nothing here depends on how long anything takes. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Records when the module's own client disconnects, which is the last thing its shutdown does. */
function recordDisconnect(moduleRef: TestingModule, events: string[]): void {
  const prisma = moduleRef.get<PrismaClient>(PRISMA_CLIENT);
  const disconnect = prisma.$disconnect.bind(prisma);
  jest.spyOn(prisma, "$disconnect").mockImplementation(async () => {
    events.push("database disconnected");
    await disconnect();
  });
}

/** Holds `held`'s sweeps until released and lets the other finish at once. */
function holdSweep(moduleRef: TestingModule, held: Sweep, events: string[]) {
  const started = gate();
  const release = gate();
  let calls = 0;
  const run = async (sweep: Sweep): Promise<number> => {
    if (sweep !== held) return 0;
    calls += 1;
    started.open();
    await release.opened;
    events.push(`${sweep} finished`);
    return 0;
  };
  // Stubbed where each sweep reaches the database, so neither touches rows other suites own.
  jest.spyOn(moduleRef.get(UploadCleanupService), "cleanupExpiredUploads").mockImplementation(() => run("upload-cleanup"));
  jest.spyOn(moduleRef.get(AbuseControlRepository), "pruneCountersBefore").mockImplementation(() => run("abuse-control-sweep"));
  return { started: started.opened, release: release.open, calls: () => calls };
}

describe("closing the app waits for the sweep in flight", () => {
  it.each<Sweep>(["upload-cleanup", "abuse-control-sweep"])(
    "lets the %s sweep finish before the database disconnects",
    async (sweep) => {
      const moduleRef = await buildModule();
      const events: string[] = [];
      recordDisconnect(moduleRef, events);
      const held = holdSweep(moduleRef, sweep, events);

      let closing: Promise<void> | undefined;
      try {
        await moduleRef.init();
        await held.started;
        closing = moduleRef.close();
        // Ample time for a close that does not wait to reach the disconnect; one that waits is still held.
        await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 200))]);
        expect(events).toEqual([]);

        held.release();
        await closing;
        expect(events).toEqual([...Array<string>(held.calls()).fill(`${sweep} finished`), "database disconnected"]);

        const callsWhenClosed = held.calls();
        await new Promise((resolve) => setTimeout(resolve, EVERY_MS * 10));
        expect(held.calls()).toBe(callsWhenClosed);
      } finally {
        held.release();
        await (closing ?? moduleRef.close());
      }
    },
  );
});
