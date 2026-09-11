import "reflect-metadata";
// Same side-effect import as main.ts, and for the same ESM ordering reason stated there.
import "@scvs/config/load-env";
// Must stay above the AppModule import — see the file itself for why, and for the silent `process.exit(1)` it
// prevents.
import "./openapi-placeholder-db.js";
import { writeFile } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { buildOpenApiDocument } from "./openapi.js";

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.init();

  const document = buildOpenApiDocument(app);
  const outFile = new URL("../openapi.json", import.meta.url);
  await writeFile(outFile, `${JSON.stringify(document, null, 2)}\n`);

  await app.close();
  console.log(`[query-svc] wrote ${outFile.pathname}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[query-svc] failed to generate openapi.json", error);
  process.exit(1);
});
