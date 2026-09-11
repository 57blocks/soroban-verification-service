import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { applyDerivedSchemas } from "@scvs/openapi";

// Route explorer only — see verification-svc/src/openapi.ts's comment; response shapes are documented by the
// @scvs/core / @scvs/storage-layout DTO classes, not re-derived here.
export function buildOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  return applyDerivedSchemas(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Soroban Query API")
        .setDescription("Public read API for aggregated Soroban contract verification results.")
        .setVersion("1")
        .build(),
    ),
  );
}
