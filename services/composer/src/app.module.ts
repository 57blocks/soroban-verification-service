import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { createEnvValidator } from "@scvs/config";
import configuration from "./config/configuration.js";
import { ComposerEnvDto } from "./config/env.dto.js";
import { ComposerModule } from "./modules/composer/composer.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: createEnvValidator(ComposerEnvDto, "composer"),
    }),
    ComposerModule,
  ],
})
export class AppModule {}
