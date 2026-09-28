import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createResultStorage,
  writeVerifierManifest,
  writeVerifierPolicy,
} from "@scvs/storage-layout";
import { ConfigurationError } from "../../config/configuration-error.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class VerifierIdentityPublisher implements OnModuleInit {
  private readonly logger = new Logger("orchestrator-svc");

  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    const verifier = this.configService.get("verifierIdentity", { infer: true });
    const verifierPolicy = this.configService.get("verifierPolicy", { infer: true });
    const storage = createResultStorage(this.configService.get("resultStorage", { infer: true }));

    if (!storage.crossProcessAtomicWrites && process.env.SCVS_SINGLE_WRITER !== "true") {
      throw new ConfigurationError(
        "SCVS_SINGLE_WRITER",
        `SCVS_PUBLISHER_STORAGE=${storage.kind} cannot guarantee a conditional write across processes ` +
          "(see docs/invariants.md rule 38), so it is safe only with ONE orchestrator writing this result " +
          "root. Set SCVS_SINGLE_WRITER=true to state that this deployment runs one, or use an AWS S3 " +
          "bucket with no custom endpoint.",
      );
    }

    try {
      await writeVerifierPolicy(storage, { policyId: verifier.policyId, ...verifierPolicy });
      this.logger.log(`published policy.json (policy_id=${verifier.policyId})`);
    } catch (error) {
      this.logger.error("failed to publish policy.json at startup", error as Error);
    }

    try {
      await writeVerifierManifest(storage, {
        id: verifier.id,
        displayName: verifier.displayName,
        resultRootUrl: storage.publicRoot,
      });
      this.logger.log(`published verifier-manifest.json (id=${verifier.id})`);
    } catch (error) {
      this.logger.error("failed to publish verifier-manifest.json at startup", error as Error);
    }
  }
}
