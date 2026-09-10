import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { applyDerivedSchemas } from "@scvs/openapi";
import { submitResponseVariants } from "./modules/verifications/submit.dto.js";
import type { AppConfigService } from "./config/configuration.js";

// Request/response bodies are `class-validator`/`@nestjs/swagger`-decorated DTO classes from this service's own
// modules/*/*.dto.ts (plus @scvs/core).
export function buildOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  // The service's own version, not a hardcoded "1" — the same value `/health` reports, so a document and a
  // running instance can be told apart by it.
  const version = app.get<AppConfigService>(ConfigService).get("serviceVersion", { infer: true });
  return applyDerivedSchemas(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Soroban Verification API")
        .setDescription("Submit and track Soroban contract source verification jobs.")
        .setVersion(version)
        .build(),
      { extraModels: [...submitResponseVariants] },
    ),
  );
}
