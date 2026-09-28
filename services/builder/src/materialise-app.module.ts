import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { createEnvValidator } from "@scvs/core";
import configuration from "./config/configuration.js";
import { BuilderEnvDto } from "./config/env.dto.js";
import { MaterialiseModule } from "./modules/materialise/materialise.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: createEnvValidator(BuilderEnvDto, "builder"),
    }),
    MaterialiseModule,
  ],
})
export class MaterialiseAppModule {}
