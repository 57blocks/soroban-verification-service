import "reflect-metadata";
// Loads this process's .env files — cwd first, then the workspace root's shared one.
import "@scvs/config/load-env";
import { formatConfigContractLogLine } from "@scvs/config";
import { applyHttpServerTimeouts, ScvsLogger } from "@scvs/core";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { SwaggerModule } from "@nestjs/swagger";
import cors from "cors";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { LegalService } from "./modules/legal/legal.service.js";
import { buildOpenApiDocument } from "./openapi.js";
import type { AppConfigService } from "./config/configuration.js";

const logger = new ScvsLogger("verification-svc-bootstrap");

async function bootstrap(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // `NODE_ENV` gates whether the app boots into test mode at all, before `ConfigService` exists — same
    // bootstrap-time exception as query-svc/src/main.ts.
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });

  // helmet already sends `Referrer-Policy: no-referrer` on every response, which is the strict policy
  // retention-and-pseudonymisation design.md RP-5 asks for; response-headers.spec.ts asserts it so
  // configuring helmet cannot silently drop it.
  app.use(helmet());

  // Nothing this API serves belongs in a search index — a job id is a bearer capability, and the published
  // records are meant to be read through the bulk-load stream, not crawled.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });

  app.set("trust proxy", [
    "loopback",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
  ]);

  // Unconditionally `*`, error responses included. The API is public and unauthenticated, and a browser that
  // cannot read the error body sees a network failure instead of the reason.
  app.enableCors({ origin: "*", methods: ["GET", "POST"] });

  const document = buildOpenApiDocument(app);
  // `customSiteTitle` is set because it otherwise defaults to "Swagger UI" — identical on both services, and
  // identical to nothing useful.
  SwaggerModule.setup("api/verification/v1/docs", app, document, {
    customSiteTitle: "Soroban Verification API",
    jsonDocumentUrl: "api/verification/v1/openapi.json",
  });

  // Without this, SIGTERM kills the process outright and `DrainService.beforeApplicationShutdown` never runs.
  app.enableShutdownHooks();

  await app.init();

  // Needs the database, so it cannot live in `onModuleInit` — `generate-openapi.ts` boots this same module
  // with no database at all. Same seam as `configureDb()`, which only serving entrypoints call.
  await app.get(LegalService).assertNoVersionConflict();

  return app;
}

if (process.env.NODE_ENV !== "test") {
  bootstrap()
    .then(async (app) => {
      const config = app.get<AppConfigService>(ConfigService);
      const port = config.get("port", { infer: true });
      await app.listen(port);
      // After listen(), never before: Nest has no `http.Server` to configure until it is bound. Left unset,
      // Node's own 5 s keepAliveTimeout sits below the balancer's idle timeout and turns a reused connection
      // into a 502.
      applyHttpServerTimeouts(app.getHttpServer(), config.get("httpTimeouts", { infer: true }));
      return port;
    })
    .then((port) => {
      // CI asserts this line; it needs no ingress, which is why it works for a service with none.
      console.log(formatConfigContractLogLine("verification-svc"));
      logger.log("Verification API listening", {
        port,
        routes: [
          "GET /health",
          "GET /api/verification/v1/health",
          "POST /api/verification/v1/preflight",
          "POST /api/verification/v1/verifications",
          "POST /api/verification/v1/uploads/source",
          "GET /api/verification/v1/verifications/:job_id",
          "GET /api/verification/v1/verifications/:job_id/events (SSE)",
          "GET /api/verification/v1/verifications/:job_id/log",
          "GET /api/verification/v1/wasms/:wasm_hash.json",
          "GET /api/verification/v1/wasms",
          "GET /api/verification/v1/docs",
          "GET /api/verification/v1/wasms.json (deprecated)",
        ],
      });
    })
    .catch((error) => {
      logger.error("fatal startup error", { error });
      process.exit(1);
    });
}

export { bootstrap };
