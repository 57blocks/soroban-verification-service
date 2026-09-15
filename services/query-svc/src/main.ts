import "reflect-metadata";
// Loads this process's .env files — cwd first, then the workspace root's shared one.
import "@scvs/config/load-env";
import { formatConfigContractLogLine } from "@scvs/config";
import { applyHttpServerTimeouts, ScvsLogger } from "@scvs/core";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule } from "@nestjs/swagger";
import cors from "cors";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { AggregationSyncService } from "./modules/aggregation/aggregation-sync.service.js";
import { buildOpenApiDocument } from "./openapi.js";
import type { AppConfigService } from "./config/configuration.js";

const logger = new ScvsLogger("query-svc-bootstrap");

async function bootstrap(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Passing the instance rather than a level list replaces Nest's own logger from the very first record,
    // including the ones module initialisation emits before `app.init()` returns (O1).
    logger: process.env.NODE_ENV === "test" ? false : logger,
  });

  const configService = app.get<AppConfigService>(ConfigService);

  app.use(helmet());

  // Load-bearing for the quota, not cosmetic: without it `req.ip` is the ALB node's address, so every caller
  // behind the balancer shares one counter and the rate limit either refuses everyone at once or fragments a
  // single caller's burst across proxy nodes. Same private ranges verification-svc trusts — see its main.ts.
  app.set("trust proxy", ["loopback", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);

  app.enableCors({ origin: configService.get("corsOrigin", { infer: true }) });

  const document = buildOpenApiDocument(app);
  // `customSiteTitle`: see verification-svc — the `<title>` is what a probe uses to tell this document apart
  // from the SPA, since both answer `200 text/html`.
  SwaggerModule.setup("api/query/v1/docs", app, document, {
    customSiteTitle: "Soroban Query API",
    jsonDocumentUrl: "api/query/v1/openapi.json",
  });

  // Without this, SIGTERM kills the process outright and `DrainService.beforeApplicationShutdown` never runs.
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
      // After listen(), never before: Nest has no `http.Server` to configure until it is bound. The quota
      // bounds how many requests a caller may make; these bound how long any one of them may hold a
      // connection, which no request counter can express.
      applyHttpServerTimeouts(httpServer, config.get("httpTimeouts", { infer: true }));
      // After listening, and never from a lifecycle hook: `generate-openapi.ts` initialises this application
      // with no database.
      app.get(AggregationSyncService).start();
      // CI asserts this line; it needs no ingress, which is why it works for a service with none.
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
