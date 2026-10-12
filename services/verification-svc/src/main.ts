import "reflect-metadata";
import "@scvs/config/load-env";
import { formatConfigContractLogLine } from "@scvs/config";
import { applyHttpServerTimeouts, ScvsLogger } from "@scvs/core";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { SwaggerModule } from "@nestjs/swagger";
import { ThrottlerStorage } from "@nestjs/throttler";
import cors from "cors";
import helmet from "helmet";
import { adapterRouteThrottle } from "@scvs/http";
import { AppModule } from "./app.module.js";
import { LegalService } from "./modules/legal/legal.service.js";
import { buildOpenApiDocument } from "./openapi.js";
import type { AppConfigService } from "./config/configuration.js";

const logger = new ScvsLogger("verification-svc-bootstrap");

async function bootstrap(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });

  app.use(helmet());

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

  app.enableCors({ origin: "*", methods: ["GET", "POST"] });

  const document = buildOpenApiDocument(app);

  // Must be registered before SwaggerModule.setup, whose routes no Nest guard reaches.
  app.use(
    adapterRouteThrottle({
      storage: app.get(ThrottlerStorage),
      limit: app.get<AppConfigService>(ConfigService).get("readThrottleLimit", { infer: true }),
      ttlMs: 60_000,
      prefixes: ["/api/verification/v1/docs", "/api/verification/v1/docs-yaml", "/api/verification/v1/openapi.json"],
    }),
  );

  SwaggerModule.setup("api/verification/v1/docs", app, document, {
    customSiteTitle: "Soroban Verification API",
    jsonDocumentUrl: "api/verification/v1/openapi.json",
  });

  app.enableShutdownHooks();

  await app.init();

  // Needs the database, so not in `onModuleInit`: generate-openapi.ts boots this module without one.
  await app.get(LegalService).assertNoVersionConflict();

  return app;
}

if (process.env.NODE_ENV !== "test") {
  bootstrap()
    .then(async (app) => {
      const config = app.get<AppConfigService>(ConfigService);
      const port = config.get("port", { infer: true });
      const httpServer = await app.listen(port);
      // After listen(): there is no `http.Server` to configure until it is bound.
      applyHttpServerTimeouts(httpServer, config.get("httpTimeouts", { infer: true }));
      return port;
    })
    .then((port) => {
      // CI asserts this line.
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
