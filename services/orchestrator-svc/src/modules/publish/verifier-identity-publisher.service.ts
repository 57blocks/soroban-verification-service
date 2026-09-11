import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { writeVerifierManifest, writeVerifierPolicy } from "@scvs/storage-layout";
import { buildResultStorage } from "./result-storage.util.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Writes `policy.json` and `verifier-manifest.json` once, at process startup, rather than on every publish. */
@Injectable()
export class VerifierIdentityPublisher implements OnModuleInit {
  private readonly logger = new Logger("orchestrator-svc");

  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    const verifier = this.configService.get("verifierIdentity", { infer: true });
    const verifierPolicy = this.configService.get("verifierPolicy", { infer: true });
    const storage = buildResultStorage(this.configService.get("resultStorage", { infer: true }));

    try {
      await writeVerifierPolicy(storage, { policyId: verifier.policyId, ...verifierPolicy });
      this.logger.log(`published policy.json (policy_id=${verifier.policyId})`);
    } catch (error) {
      // Best-effort, like recordPublishFailure elsewhere in this module: a result-storage outage at boot should
      // not crash the whole service, since the verification pipeline itself does not depend on policy.json
      // existing.
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
