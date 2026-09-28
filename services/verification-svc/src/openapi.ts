import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from "@nestjs/swagger";
import { applyDerivedSchemas } from "@scvs/openapi";
import { submitResponseVariants } from "./modules/verifications/submit.dto.js";
import type { AppConfigService } from "./config/configuration.js";

export function buildOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
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
