import "reflect-metadata";
import "@scvs/config/load-env";
import { formatConfigContractLogLine } from "@scvs/config";
import { applyHttpServerTimeouts, ScvsLogger } from "@scvs/core";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import type { AppConfigService } from "./config/configuration.js";

const HEALTH_HOST = "127.0.0.1";

const logger = new ScvsLogger("orchestrator-bootstrap");

async function bootstrap(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NODE_ENV === "test" ? false : logger,
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
      const httpServer = await app.listen(port, HEALTH_HOST);
      applyHttpServerTimeouts(httpServer, config.get("httpTimeouts", { infer: true }));
      return port;
    })
    .then((port) => {
      // CI asserts this line.
      console.log(formatConfigContractLogLine("orchestrator-svc"));
      logger.log("health check listening", { host: HEALTH_HOST, port, path: "/health" });
    })
    .catch((error) => {
      logger.error("fatal startup error", { error });
      process.exit(1);
    });
}

export { bootstrap };
