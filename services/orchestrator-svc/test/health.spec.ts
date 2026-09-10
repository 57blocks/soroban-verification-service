import type { Server } from "node:http";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../src/app.module.js";
import { BatchEventConsumerService } from "../src/modules/batch-events/batch-event-consumer.service.js";
import { ArchiveRecoveryScheduler } from "../src/modules/scheduler/archive-recovery.scheduler.js";
import { BuildDispatchScheduler } from "../src/modules/scheduler/build-dispatch.scheduler.js";
import { EnvironmentReconcilerScheduler } from "../src/modules/scheduler/environment-reconciler.scheduler.js";
import { PublishRecoveryScheduler } from "../src/modules/scheduler/publish-recovery.scheduler.js";
import { RebuildReconcilerScheduler } from "../src/modules/scheduler/rebuild-reconciler.scheduler.js";
import { StartupRecoveryService } from "../src/modules/scheduler/startup-recovery.service.js";

// Compile the real AppModule, but replace resident background workers before app.init().
let app: NestExpressApplication;
let server: Server;

beforeAll(async () => {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  for (const provider of [
    BatchEventConsumerService,
    StartupRecoveryService,
    BuildDispatchScheduler,
    PublishRecoveryScheduler,
    ArchiveRecoveryScheduler,
    RebuildReconcilerScheduler,
    EnvironmentReconcilerScheduler,
  ]) {
    builder.overrideProvider(provider).useValue({});
  }
  const moduleRef = await builder.compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  server = app.getHttpServer();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
