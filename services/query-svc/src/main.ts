import "reflect-metadata";
import "@scvs/config/load-env";
import { formatConfigContractLogLine } from "@scvs/config";
import { applyHttpServerTimeouts, ScvsLogger } from "@scvs/core";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule } from "@nestjs/swagger";
import { ThrottlerStorage } from "@nestjs/throttler";
import cors from "cors";
import helmet from "helmet";
import { adapterRouteThrottle } from "@scvs/http";
import { AppModule } from "./app.module.js";
import { AggregationSyncService } from "./modules/aggregation/aggregation-sync.service.js";
import { buildOpenApiDocument } from "./openapi.js";
import type { AppConfigService } from "./config/configuration.js";

const logger = new ScvsLogger("query-svc-bootstrap");

async function bootstrap(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });

  const configService = app.get<AppConfigService>(ConfigService);

  app.use(helmet());

  // Load-bearing for the quota: without it `req.ip` is the load balancer node, so all callers share one counter.
  app.set("trust proxy", ["loopback", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);

  app.enableCors({ origin: configService.get("corsOrigin", { infer: true }) });

  const document = buildOpenApiDocument(app);

  // Must be registered before SwaggerModule.setup, whose routes no Nest guard reaches.
  app.use(
    adapterRouteThrottle({
      storage: app.get(ThrottlerStorage),
      limit: configService.get("queryThrottleLimit", { infer: true }),
      ttlMs: 60_000,
      prefixes: ["/api/query/v1/docs", "/api/query/v1/docs-yaml", "/api/query/v1/openapi.json"],
    }),
  );

  // The host-routing probe matches this `<title>` to tell the docs page from the SPA.
  SwaggerModule.setup("api/query/v1/docs", app, document, {
    customSiteTitle: "Soroban Query API",
    jsonDocumentUrl: "api/query/v1/openapi.json",
  });

  app.enableShutdownHooks();

  await app.init();

  return app;
}

if (process.env.NODE_ENV !== "test") {
  bootstrap()
    .then(async (app) => {
      const config = app.get<AppConfigService>(ConfigService);
      const port = config.get("port", { infer: true });
      const httpServer = await app.listen(port);
      applyHttpServerTimeouts(httpServer, config.get("httpTimeouts", { infer: true }));
      app.get(AggregationSyncService).start();
      // CI asserts this line.
      console.log(formatConfigContractLogLine("query-svc"));
      logger.log("Public Query API listening", {
        port,
        routes: [
          "GET /api/query/v1/wasms/:wasm_hash",
          "GET /api/query/v1/contracts/:network/:contract_id",
          "GET /api/query/v1/wasms",
          "GET /api/query/v1/verifiers",
          "GET /api/query/v1/health",
          "GET /api/query/v1/docs",
          "GET /api/query/v1/wasms/:wasm_hash.json (deprecated)",
          "GET /api/query/v1/wasms.json (deprecated)",
        ],
      });
    })
    .catch((error) => {
      logger.error("fatal startup error", { error });
      process.exit(1);
    });
}

export { bootstrap };
