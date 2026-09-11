import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration.js";
import { BuilderModule } from "./modules/builder/builder.module.js";
import { createEnvValidator } from "@scvs/core";
import { BuilderEnvDto } from "./config/env.dto.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Validation still applies to whatever the Batch job definition injected.
      validate: createEnvValidator(BuilderEnvDto, "builder"),
    }),
    BuilderModule,
  ],
})
export class AppModule {}
