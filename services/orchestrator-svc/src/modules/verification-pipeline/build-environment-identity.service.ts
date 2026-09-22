import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type BuildArchitecture,
  composedEnvironmentImageReference,
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

/**
 * Which build environment a contract's on-chain metadata names, and what Batch pulls to get it.
 *
 * It answers with an outcome instead of acting on the job. Inside the pipeline "still composing" and "failed,
 * with a reason already written" were the same `undefined` return, and only the statement order around the
 * call said which had happened; progress lines and job failure stay with the state machine that owns them.
 */

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

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    // Injected as the abstract tokens, so the e2e suite substitutes a resolver/materializer that never reaches
    // Batch or ECR.
    @Inject(BuildEnvironmentResolver)
    private readonly environmentResolver: BuildEnvironmentResolver,
    @Inject(BuildEnvironmentMaterializer)
    private readonly environmentMaterializer: BuildEnvironmentMaterializer
  ) {}

  /** The immutable identity a rebuild for this target should be keyed on. */
  async resolve(
    jobId: string,
    metadata: WasmMetadata
  ): Promise<EnvironmentIdentity> {
    const pair = metadata.toolchain_pair;

    // The chain decides the build class, not the submission: `bldimg` present in the chain-injected section
    // means the CLI recorded an image and this is cli-58.
    const chainNamedImage = metadata.sep58.bldimg;
    if (chainNamedImage) {
      const imagePolicy = evaluateBuildImage(chainNamedImage);
      if (!imagePolicy.ok) {
        // `submit-flow` already answers `4xx unsupported` for the submitter-named arm.
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
      // A missing or unserviceable chain-recorded toolchain is a preparation failure, not a submitter policy
      // violation.
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

    // `chain_named` is unreachable here — the resolver only returns it for a `sep58Image` input, and this
    // branch is only reached when the chain recorded none.
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
        // Off the request path by construction: the caller says so honestly and comes back next tick.
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
        // Half of the composer's reason codes are permanent properties of the pair, and `internal_error` is
        // *retryable* (`isRetryableFailure`).
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

  /** Turns a rebuild's persisted environment identity into something Batch can pull. */
  async resolveImageReference(
    persistedIdentity: string
  ): Promise<EnvironmentImageReference | undefined> {
    const identity = parseRebuildEnvironmentIdentity(persistedIdentity);
    if (identity.kind === "chain_named") {
      // A public, digest-pinned registry reference. Its architecture is genuinely something only the registry
      // knows, so no `arch` travels and dispatch probes as it always has.
      return { pullReference: identity.image };
    }
    const environment =
      await this.environmentMaterializer.findReadyByRecipeSha256(
        identity.recipeSha256
      );
    if (!environment) return undefined;
    return {
      // `Environment.imageDigest` is always a bare `sha256:<64 hex>` — `ComposerArtifact.image_digest`
      // validates exactly that shape, so there is no already-qualified case to handle here.
      pullReference: composedEnvironmentImageReference(
        this.composedEnvironmentRepositoryUri(),
        environment.imageDigest
      ),
      // By the time `batch-dispatch.service.ts` sees the resolved `<repo>@sha256:…` there is nothing left in it
      // to say the environment was composed, and this is the one function that already holds both facts.
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
