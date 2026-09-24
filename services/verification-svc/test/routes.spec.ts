import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient, JobsRepository, readDbEnv } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";
import { hashBuildLogToken, mintBuildLogToken } from "@scvs/core";
import { createTestApp } from "./bootstrap.js";

const prisma = createPrismaClient(readDbEnv());
const jobsRepository = new JobsRepository(prisma);
const createdRows = new CreatedRows();

let app: NestExpressApplication;
let server: Server;
beforeAll(async () => {
  app = await createTestApp();
  server = app.getHttpServer();
});

afterAll(async () => {
  try {
    await app?.close();
    await createdRows.cleanup(prisma);
  } finally {
    await prisma.$disconnect();
  }
});

// `Endpoint not found` is the catch-all controller's body — distinguishing it from a route's own 404 is what
// tells the two apart.
const CATCH_ALL_404 = "Endpoint not found";

describe("route rename", () => {
  it("serves preflight at its new path and nothing at the old one", async () => {
    const renamed = await request(server).post("/api/verification/v1/preflight").send({ contract_id: "C123" });
    expect(renamed.status).toBe(400);
    expect(renamed.body.message).not.toBe(CATCH_ALL_404);

    const old = await request(server).post("/v1/preflight").send({ contract_id: "C123" });
    expect(old.status).toBe(404);
    expect(old.body.message).toBe(CATCH_ALL_404);
  });

  it("serves submit at its new path and nothing at the old one", async () => {
    const renamed = await request(server).post("/api/verification/v1/verifications").send({ target: {} });
    expect(renamed.status).toBe(400);
    expect(renamed.body.message).not.toBe(CATCH_ALL_404);

    const old = await request(server).post("/v1/verifications").send({ target: {} });
    expect(old.status).toBe(404);
    expect(old.body.message).toBe(CATCH_ALL_404);
  });

  it("serves job status at its new path and nothing at the old one", async () => {
    const jobId = randomUUID();

    const renamed = await request(server).get(`/api/verification/v1/verifications/${jobId}`);
    expect(renamed.status).toBe(404);
    expect(renamed.body.message).toContain(jobId);

    const old = await request(server).get(`/v1/verifications/${jobId}`);
    expect(old.status).toBe(404);
    expect(old.body.message).toBe(CATCH_ALL_404);
  });

  it("rejects a malformed job id on the renamed status route rather than falling through", async () => {
    const res = await request(server).get("/api/verification/v1/verifications/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_job_id");
  });

  it("no longer serves the old SSE path", async () => {
    const res = await request(server).get(`/v1/verifications/${randomUUID()}/events`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(CATCH_ALL_404);
  });
});

describe("GET /api/verification/v1/health", () => {
  it("answers with the same body as /health", async () => {
    const v1 = await request(server).get("/api/verification/v1/health");
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ status: "ok" });
    expect(typeof v1.body.version).toBe("string");

    const bare = await request(server).get("/health");
    expect(v1.body).toEqual(bare.body);
  });

  it("no longer serves the old /v1/health path", async () => {
    const res = await request(server).get("/v1/health");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(CATCH_ALL_404);
  });

  // The Docker HEALTHCHECK and the ALB target group are pinned to these three.
  it("leaves the deployment-pinned health routes alone", async () => {
    expect((await request(server).get("/health")).status).toBe(200);
    expect((await request(server).get("/health/live")).body).toEqual({ status: "alive" });
    expect([200, 503]).toContain((await request(server).get("/health/ready")).status);
  });
});

// The exemption is what makes the ceiling survivable: a submitter watching their own accepted job is reading,
// not submitting, and throttling that shows up as console timeouts rather than as a quota message.
describe("the status route stays exempt from the abuse guard", () => {
  it("answers the status route far past any submission budget", async () => {
    const jobId = randomUUID();
    for (let i = 0; i < 12; i++) {
      const res = await request(server).get(`/api/verification/v1/verifications/${jobId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    }
  });

  it("keeps @SkipThrottle on getJob and every guard off it", async () => {
    // ★ `getBuildLog` is deliberately not exempt: it authenticates, and an unauthenticated caller guessing
    // tokens against it must be metered (build-log-access BL-5).
    // ★ `jobEvents` is also not exempt — see the next `describe`.
    const { VerificationsController } = await import("../src/modules/verifications/verifications.controller.js");
    // `@SkipThrottle()` stores under the constant suffixed with the throttler's name, which is "default" for
    // the unnamed one wired in app.module.ts.
    const handler = (name: string) => (VerificationsController.prototype as never)[name] as object;
    const skipsThrottle = (name: string) => Reflect.getMetadata("THROTTLER:SKIPdefault", handler(name));
    const guards = (name: string) => Reflect.getMetadata("__guards__", handler(name)) ?? [];

    expect(skipsThrottle("getJob")).toBe(true);
    expect(guards("getJob")).toHaveLength(0);
    // The log routes are the other side of that line, and stating it here is what keeps the exemption from
    // creeping back onto them.
    expect(skipsThrottle("getBuildLog")).toBeUndefined();
    expect(guards("getBuildLog").length).toBeGreaterThan(0);
    expect(guards("deleteBuildLog").length).toBeGreaterThan(0);
    // Method-level metadata is all `__guards__` sees, so a class-level `@UseGuards` would be invisible here and
    // this assertion would pass while the routes were in fact guarded.
    expect(Reflect.getMetadata("__guards__", VerificationsController)).toBeUndefined();

    // The other half of the same fact: submit DOES carry the guard, so the assertions above are about getJob
    // specifically rather than about the guard never being applied at all.
    expect(guards("submit").length).toBeGreaterThan(0);
    // uploadSource carries no controller guard at all — RawArchiveBodyMiddleware runs the equivalent drain and
    // abuse checks itself, before the body is buffered rather than after (raw-archive-body.middleware.ts).
    expect(guards("uploadSource")).toHaveLength(0);
  });
});

// See verifications.controller.ts's jobEvents route for why it keeps @SkipThrottle and carries AbuseGuard.
describe("the SSE stream route is guarded by AbuseGuard but keeps @SkipThrottle", () => {
  it("keeps @SkipThrottle on jobEvents and guards it with AbuseGuard", async () => {
    const { VerificationsController } = await import("../src/modules/verifications/verifications.controller.js");
    const { AbuseGuard } = await import("../src/common/abuse.guard.js");
    const handler = (name: string) => (VerificationsController.prototype as never)[name] as object;
    const skipsThrottle = (name: string) => Reflect.getMetadata("THROTTLER:SKIPdefault", handler(name));
    const guards = (name: string) => Reflect.getMetadata("__guards__", handler(name)) ?? [];

    expect(skipsThrottle("jobEvents")).toBe(true);
    expect(guards("jobEvents")).toContain(AbuseGuard);
  });
});

// The route ships ahead of the sandbox-side work that fills the column, so its correct answer today is a 404
// that says why — never fabricated content, and never a 500 from reading a null key.
describe("GET /api/verification/v1/verifications/:job_id/log", () => {
  it("404s with a reason for a job that recorded no log", async () => {
    const jobId = createdRows.job(randomUUID());
    const token = mintBuildLogToken();
    await jobsRepository.createJob({
      jobId,
      dryRun: false,
      buildLogTokenHash: hashBuildLogToken(token),
      target: { network: "testnet", contract_id: `C${randomBytes(20).toString("hex").toUpperCase()}` },
      verificationMode: "submitted",
      sourceRef: {
        type: "source_uri",
        visibility: "public",
        source_uri: "https://example.com/log-fixture.tar.gz",
        source_sha256: "0".repeat(64),
      } as never,
      buildOptions: {},
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        target: { network: "testnet" },
        bldimg: `docker.io/stellar/stellar-cli@sha256:${"e".repeat(64)}`,
        source_sha256: "0".repeat(64),
        source_uri: "https://example.com/log-fixture.tar.gz",
      } as never,
    });

    // Without a token the route answers 401 before it looks at the job at all — that ladder is
    // `build-log-access.spec.ts`'s subject. This case is about the body BEHIND it, so it carries the token.
    const res = await request(server)
      .get(`/api/verification/v1/verifications/${jobId}/log`)
      .set("X-Build-Log-Token", token);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(res.body.message).toContain("No build log");
    // The status is what tells a reader whether "no log" is expected for this job.
    expect(res.body.job_status).toBe("queued");
  });

  it("404s for an unknown job from the route, not the catch-all", async () => {
    const jobId = randomUUID();
    const res = await request(server)
      .get(`/api/verification/v1/verifications/${jobId}/log`)
      .set("X-Build-Log-Token", mintBuildLogToken());
    expect(res.status).toBe(404);
    // Naming the job is what distinguishes the route's own answer from `Endpoint not found`; without it,
    // deleting the route entirely would leave this test green.
    expect(res.body.message).not.toBe(CATCH_ALL_404);
    expect(res.body.message).toContain(jobId);
  });

  it("rejects a malformed job id", async () => {
    const res = await request(server).get("/api/verification/v1/verifications/not-a-uuid/log");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_job_id");
  });
});

// A single-instance circuit breaker split across two instances is two independent circuit breakers — see
// abuse-guard.module.ts's header for the failure this guards against.
describe("AbuseGuardService DI wiring", () => {
  it("is the same instance for the preflight route and the verifications route", async () => {
    const { NestFactory } = await import("@nestjs/core");
    const { AppModule } = await import("../src/app.module.js");
    const { PreflightModule } = await import("../src/modules/preflight/preflight.module.js");
    const { VerificationsModule } = await import("../src/modules/verifications/verifications.module.js");
    const { AbuseGuardService } = await import("../src/common/abuse-guard.js");

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    try {
      const fromPreflight = app.select(PreflightModule).get(AbuseGuardService);
      const fromVerifications = app.select(VerificationsModule).get(AbuseGuardService);
      expect(fromPreflight).toBe(fromVerifications);
    } finally {
      await app.close();
    }
  });
});

// A 401 or 403 here would mean a credentialled surface exists, which is the thing the rule forbids — so it
// fails this test rather than passing it.
describe("no runtime trust-mutation surface", () => {
  it.each([
    ["get", "/admin/build-images"],
    ["post", "/admin/build-images"],
    ["delete", "/admin/build-images/00000000-0000-0000-0000-000000000000"],
    ["get", "/admin/build-images/audit"],
    ["get", "/admin"],
  ])("answers the catch-all 404 for %s %s", async (method, path) => {
    const res = await (request(server) as never as Record<string, (p: string) => request.Test>)[method](path).send();
    expect(res.status).toBe(404);
    expect(res.body.message).toBe(CATCH_ALL_404);
  });

  it("advertises no /admin path in the OpenAPI document", async () => {
    const { buildOpenApiDocument } = await import("../src/openapi.js");
    const { NestFactory } = await import("@nestjs/core");
    const { AppModule } = await import("../src/app.module.js");

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    try {
      expect(Object.keys(buildOpenApiDocument(app as never).paths).filter((p) => p.includes("admin"))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
