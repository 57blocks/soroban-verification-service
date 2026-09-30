import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type BuildArchitecture,
  composedEnvironmentImageReference,
  DENIED_IMAGE_DIGESTS,
  evaluateBuildImage,
  type FailureReason,
  isPermanentCompositionFailure,
  parseRebuildEnvironmentIdentity,
  ScvsLogger,
} from "@scvs/core";
import {
  BuildEnvironmentMaterializer,
  BuildEnvironmentResolver,
} from "../build-environments/index.js";
import type { WasmMetadata } from "./chain-reader.service.js";
import type { AppConfigService } from "../../config/configuration.js";
import { ConfigurationError } from "../../config/configuration-error.js";

export type EnvironmentIdentity =
  | { kind: "resolved"; identity: string }
  | { kind: "composing"; environmentId: string }
  | {
      kind: "failed";
      reason: FailureReason;
      reasonCode: string;
      detail?: string;
    };

export type EnvironmentImageReference = {
  pullReference: string;
  arch?: BuildArchitecture;
};

@Injectable()
export class BuildEnvironmentIdentityService {
  private readonly logger = new ScvsLogger("build-environment-identity");
  protected readonly deniedImageDigests: readonly string[] = DENIED_IMAGE_DIGESTS;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(BuildEnvironmentResolver)
    private readonly environmentResolver: BuildEnvironmentResolver,
    @Inject(BuildEnvironmentMaterializer)
    private readonly environmentMaterializer: BuildEnvironmentMaterializer
  ) {}

  async resolve(
    jobId: string,
    metadata: WasmMetadata
  ): Promise<EnvironmentIdentity> {
    const pair = metadata.toolchain_pair;

    // The chain decides the build class: a chain-recorded bldimg means cli-58.
    const chainNamedImage = metadata.sep58.bldimg;
    if (chainNamedImage) {
      const imagePolicy = evaluateBuildImage(chainNamedImage, this.deniedImageDigests);
      if (!imagePolicy.ok) {
        return {
          kind: "failed",
          reason: "unsupported",
          reasonCode: imagePolicy.reason,
          ...(imagePolicy.detail ? { detail: imagePolicy.detail } : {}),
        };
      }
      this.logger.log(
        "cli-58 target: using the chain-named, policy-accepted image",
        {
          image: imagePolicy.image,
          trust_level: imagePolicy.trust_level,
        }
      );
      return { kind: "resolved", identity: imagePolicy.image };
    }

    const resolution = await this.environmentResolver.resolve({
      ...(pair ? { pair } : {}),
    });
    if (resolution.kind === "unsupported") {
      this.logger.warn("target's recorded toolchain cannot be served", {
        reason: resolution.reason,
        cliver: pair?.cliver,
        rsver: pair?.rsver,
      });
      return {
        kind: "failed",
        reason: "unsupported",
        reasonCode: resolution.reason,
        detail:
          "The toolchain this contract records cannot be reproduced from official, released components, " +
          "so no verification was attempted.",
      };
    }

    if (resolution.kind === "chain_named") {
      return { kind: "resolved", identity: resolution.image };
    }

    const materialized = await this.environmentMaterializer.materialize(
      resolution.intent,
      jobId
    );
    switch (materialized.kind) {
      case "ready":
        this.logger.log("cli-legacy target: composed environment is ready", {
          environment_id: materialized.environmentId,
          cliver: resolution.intent.pair.cliver,
          rsver: resolution.intent.pair.rsver,
          recipe_sha256: materialized.environment.recipeSha256,
        });
        return {
          kind: "resolved",
          identity: materialized.environment.recipeSha256,
        };
      case "composing":
        this.logger.log(
          "cli-legacy target: waiting on environment composition",
          {
            environment_id: materialized.environmentId,
            cliver: resolution.intent.pair.cliver,
            rsver: resolution.intent.pair.rsver,
          }
        );
        return { kind: "composing", environmentId: materialized.environmentId };
      case "failed": {
        const permanent = isPermanentCompositionFailure(materialized.errorCode);
        return {
          kind: "failed",
          reason: permanent ? "policy_rejected" : "build_failed",
          reasonCode: materialized.errorCode,
          detail: permanent
            ? "The build environment this contract records cannot be composed from official, released " +
              "components, so no verification was attempted."
            : "The build environment this contract records could not be composed. This is a problem on " +
              "the verifier's side, not with the submission.",
        };
      }
    }
  }

  async resolveImageReference(
    persistedIdentity: string
  ): Promise<EnvironmentImageReference | undefined> {
    const identity = parseRebuildEnvironmentIdentity(persistedIdentity);
    if (identity.kind === "chain_named") {
      if (!evaluateBuildImage(identity.image, this.deniedImageDigests).ok) {
        this.logger.warn("refusing to dispatch against a chain-named image the policy no longer accepts", {
          image: identity.image,
        });
        return undefined;
      }
      return { pullReference: identity.image };
    }
    const environment =
      await this.environmentMaterializer.findReadyByRecipeSha256(
        identity.recipeSha256
      );
    if (!environment) return undefined;
    return {
      pullReference: composedEnvironmentImageReference(
        this.composedEnvironmentRepositoryUri(),
        environment.imageDigest
      ),
      ...(environment.arch ? { arch: environment.arch } : {}),
    };
  }

  private composedEnvironmentRepositoryUri(): string {
    const uri = this.configService.get("composedEnvironmentRepositoryUri", {
      infer: true,
    });
    if (!uri) {
      throw new ConfigurationError(
        "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI",
        "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI is required to dispatch a rebuild against a composed " +
          "build environment (ADR-017)."
      );
    }
    return uri;
  }
}
