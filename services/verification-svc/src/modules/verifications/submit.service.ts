import { randomUUID } from "node:crypto";
import { evaluateBuildImage, hashBuildLogToken, imagePolicyErrorCode, mintBuildLogToken } from "@scvs/core";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobsRepository, UploadJobReferencesRepository, UploadsRepository } from "@scvs/db";
import {
  parseDto,
  ScvsLogger,
  SubmittedSourceManifest,
  type LogFields,
  type SourceReference,
  type VerificationMode,
  type VerificationTarget,
} from "@scvs/core";
import {
  compareSourceAgainstChain,
  getWasmMetadata,
  runPreflight,
  validateSubmittedManifest,
  type ChainReaderConfig,
  type ManifestValidation,
} from "../preflight/index.js";

import { LegalService } from "../legal/legal.service.js";
import type { SubmitRequestDto } from "./submit.dto.js";
import type { AppConfigService } from "../../config/configuration.js";
import { errorBody } from "@scvs/http";

type CreatedJob = { jobId: string; buildLogToken: string };

type AcceptedTerms = { version?: string; contentSha256?: string };

export type ApiResponse = { statusCode: number; body: unknown };

const SEP58_FIELD_HINTS: Record<
  string,
  { description: string; format: string; example: string }
> = {
  source_sha256: {
    description:
      "Required. SHA-256 of the source archive's exact bytes. The archive must contain files under a single top-level directory. Pair with source_uri to provide a download location.",
    format: "^[0-9a-f]{64}$",
    example: "28a148275748e65c00211f3c7308e879cd246f6cc23b53b2bf7d90f8c9845063",
  },
  source_uri: {
    description:
      "Required when the WASM metadata records source_sha256 but no source_uri. Provide a URI or local development path for the exact source archive.",
    format: "^[a-zA-Z][a-zA-Z0-9+.-]*:\\S+$",
    example: "https://example.com/my-contract-v1.0.0.tar.gz",
  },
};

function targetFields(target: VerificationTarget): LogFields {
  return {
    network: target.network,
    contract_id: target.contract_id,
    wasm_hash: target.wasm_hash,
  };
}

function declaredVisibility(manifest: SubmittedSourceManifest): "public" | "private" {
  return (manifest.is_public ?? false) ? "public" : "private";
}

@Injectable()
export class SubmitService {
  private readonly logger = new ScvsLogger("submit");

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(UploadsRepository) private readonly uploads: UploadsRepository,
    @Inject(UploadJobReferencesRepository) private readonly uploadJobReferences: UploadJobReferencesRepository,
    @Inject(LegalService) private readonly legal: LegalService
  ) {}

  async submit(body: SubmitRequestDto): Promise<ApiResponse> {
    const target = body.target as VerificationTarget;
    const manifest = body.manifest;

    // Before the chain read: a submission that forms no agreement must cost nothing.
    const acceptance = this.legal.checkAcceptance(body.accepted_terms_version);
    if (!acceptance.accepted) {
      this.logger.warn("submission rejected on terms acceptance", {
        ...targetFields(target),
        error: acceptance.error,
      });
      return {
        statusCode: 400,
        body: errorBody(400, { error: acceptance.error, message: acceptance.message }),
      };
    }

    this.logger.log("submission received", {
      ...targetFields(target),
      manifest: manifest ? "submitted" : "absent",
      dry_run: body.dry_run ?? false,
    });

    const dryRun = body.dry_run ?? false;

    if (!manifest) {
      const preflight = await runPreflight(target, this.chainReaderConfig());
      if (!preflight.ok) {
        const statusCode = preflight.status === "not_found" ? 404 : 502;
        this.logger.warn("preflight failed", {
          ...targetFields(target),
          preflight_status: preflight.status,
          reason: preflight.reason,
          status_code: statusCode,
        });
        return {
          statusCode,
          body: errorBody(statusCode, {
            error: preflight.status,
            reason: preflight.reason,
            message: preflight.detail,
          }),
        };
      }

      if (
        preflight.missing_fields.length === 0 &&
        preflight.suggested_manifest
      ) {
        const inferredManifest = parseDto(
          SubmittedSourceManifest,
          preflight.suggested_manifest
        );
        this.logger.log("manifest inferred from SEP-58 metadata", {
          ...targetFields(target),
          chain_image: inferredManifest.bldimg,
        });
        if (!inferredManifest.bldimg) {
          throw new Error("preflight suggested a cli-58 manifest without its chain-recorded bldimg");
        }
        const imagePolicy = evaluateBuildImage(inferredManifest.bldimg);
        if (!imagePolicy.ok) {
          this.logger.warn("rejected by image policy", {
            ...targetFields(target),
            reason: imagePolicy.reason,
          });
          return {
            statusCode: 400,
            body: errorBody(400, {
              error: imagePolicyErrorCode(imagePolicy.reason),
              reason: imagePolicy.reason,
              detail: imagePolicy.detail,
              message: imagePolicy.detail,
            }),
          };
        }

        const enrichedTarget = preflight.target;
        const activeJob = await this.jobs.getActiveJobForTarget(
          enrichedTarget,
          this.dedupQuestion(dryRun, inferredManifest)
        );
        if (activeJob) {
          this.logger.log("reusing the in-flight job for this target", {
            ...targetFields(enrichedTarget),
            job_id: activeJob.jobId,
            job_status: activeJob.status,
          });
          return {
            statusCode: 202,
            body: {
              status: "queued",
              job_id: activeJob.jobId,
              // The caller's own target: the matched row may name a different contract that shares this Wasm.
              target,
              available_fields: preflight.available_fields,
              // No `build_log_token`: this job's token went to whoever created it.
              message:
                "A verification job for this target is already queued or running. Its build log belongs to the submission that created it.",
            },
          };
        }

        const created = await this.createJob(
          enrichedTarget,
          inferredManifest,
          "metadata",
          dryRun,
          acceptance
        );
        return this.respondToCreated(created, enrichedTarget, {
          queuedMessage:
            "Verification job created from on-chain SEP-58 metadata.",
          extra: { available_fields: preflight.available_fields },
        });
      }

      this.logger.log("submission incomplete", {
        ...targetFields(target),
        missing_fields: preflight.missing_fields,
      });

      const fieldHints = Object.fromEntries(
        preflight.missing_fields
          .filter((f) => f in SEP58_FIELD_HINTS)
          .map((f) => [f, SEP58_FIELD_HINTS[f]])
      );

      return {
        statusCode: 200,
        body: {
          status: "incomplete",
          target: preflight.target,
          missing_fields: preflight.missing_fields,
          field_hints: fieldHints,
          available_fields: preflight.available_fields,
          prefill: preflight.prefill,
          message:
            "Manifest required. Provide source and build information to proceed.",
        },
      };
    }

    const validation = validateSubmittedManifest(manifest, target);
    if (!validation.ok) {
      this.logger.warn("manifest rejected", {
        ...targetFields(target),
        reason: validation.error,
      });
      return {
        statusCode: 400,
        body: errorBody(400, {
          error: validation.error,
          detail: validation.detail,
          message: validation.detail,
        }),
      };
    }

    if (validation.manifest.upload_id) {
      const uploadCheck = await this.checkUpload(validation.manifest.upload_id, validation.manifest.source_sha256);
      if (!uploadCheck.ok) {
        this.logger.warn("manifest rejected", {
          ...targetFields(target),
          reason: uploadCheck.error,
        });
        return {
          statusCode: 400,
          body: errorBody(400, {
            error: uploadCheck.error,
            detail: uploadCheck.detail,
            message: uploadCheck.detail,
          }),
        };
      }
    }

    const chainCheck = await this.checkSourceAgainstChain(target, validation.manifest.source_sha256);
    if (!chainCheck.ok) {
      this.logger.warn("manifest rejected", {
        ...targetFields(target),
        reason: chainCheck.error,
        submitted_source_sha256: validation.manifest.source_sha256,
      });
      return {
        statusCode: 400,
        body: errorBody(400, {
          error: chainCheck.error,
          detail: chainCheck.detail,
          message: chainCheck.detail,
        }),
      };
    }

    const activeJob = await this.jobs.getActiveJobForTarget(
      target,
      this.dedupQuestion(dryRun, validation.manifest)
    );
    if (activeJob) {
      this.logger.log("reusing the in-flight job for this target", {
        ...targetFields(target),
        job_id: activeJob.jobId,
        job_status: activeJob.status,
      });
      return {
        statusCode: 202,
        body: {
          status: "queued",
          job_id: activeJob.jobId,
          target,
          message:
            "A verification job for this target is already queued or running. Its build log belongs to the submission that created it.",
        },
      };
    }

    const created = await this.createJob(
      target,
      validation.manifest,
      "submitted",
      dryRun,
      acceptance
    );
    return this.respondToCreated(created, target, {
      queuedMessage: "Verification job created and queued for processing.",
    });
  }

  private respondToCreated(
    created: CreatedJob,
    target: VerificationTarget,
    options: { queuedMessage: string; extra?: Record<string, unknown> }
  ): ApiResponse {
    this.logger.log("job accepted", { ...targetFields(target), job_id: created.jobId });
    return {
      statusCode: 202,
      body: {
        status: "queued",
        job_id: created.jobId,
        target,
        ...(options.extra ?? {}),
        // The only time this token is ever emitted; no route re-issues it.
        build_log_token: created.buildLogToken,
        message: options.queuedMessage,
      },
    };
  }

  private async checkSourceAgainstChain(
    target: VerificationTarget,
    submittedSha256: string,
  ): Promise<ManifestValidation | { ok: true }> {
    // A throwing chain read is the same as a contract that records nothing: no oracle, so no refusal.
    const lookup = await getWasmMetadata(target, this.chainReaderConfig()).catch(() => undefined);
    const chainSourceSha256 = lookup?.ok ? lookup.metadata.sep58.source_sha256 : undefined;
    return compareSourceAgainstChain(chainSourceSha256, submittedSha256);
  }

  private async checkUpload(
    uploadId: string,
    claimedSha256: string
  ): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
    const upload = await this.uploads.getUpload(uploadId);
    if (!upload || !upload.received) {
      return {
        ok: false,
        error: "upload_not_found",
        detail: `upload_id ${uploadId} does not reference a received upload. It may have expired or already been used.`,
      };
    }
    if (new Date(upload.expiresAt).getTime() <= Date.now()) {
      return {
        ok: false,
        error: "upload_expired",
        detail: `upload_id ${uploadId} has expired. Upload the source archive again.`,
      };
    }
    if (upload.sourceSha256 && upload.sourceSha256 !== claimedSha256) {
      return {
        ok: false,
        error: "source_hash_mismatch",
        detail: "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
      };
    }
    return { ok: true };
  }

  private async createJob(
    target: VerificationTarget,
    manifest: SubmittedSourceManifest,
    verificationMode: VerificationMode,
    dryRun: boolean,
    acceptance: AcceptedTerms
  ): Promise<CreatedJob> {
    const visibility = declaredVisibility(manifest);
    const sourceRef: SourceReference = manifest.upload_id
      ? {
          type: "private_tarball",
          visibility,
          source_uri: manifest.source_uri,
          source_sha256: manifest.source_sha256,
          tarball_sha256: manifest.source_sha256,
          upload_id: manifest.upload_id,
        }
      : {
          type: "source_uri",
          visibility,
          source_uri: manifest.source_uri,
          source_sha256: manifest.source_sha256,
        };

    if (manifest.upload_id) {
      await this.uploads.setUploadVisibility(manifest.upload_id, visibility);
    }

    const jobId = randomUUID();
    const buildLogToken = mintBuildLogToken();
    await this.jobs.createJob({
      jobId,
      buildLogTokenHash: hashBuildLogToken(buildLogToken),
      target,
      verificationMode,
      sourceRef,
      buildOptions: {
        bldopt: manifest.bldopt || [],
        bldarg: manifest.bldarg || [],
      },
      manifest,
      dryRun,
      // The service's own hash, never anything the request carried.
      ...(acceptance.version && acceptance.contentSha256
        ? { acceptedTermsVersion: acceptance.version, acceptedTermsSha256: acceptance.contentSha256 }
        : {}),
    });
    if (manifest.upload_id) {
      try {
        await this.uploadJobReferences.recordReference(manifest.upload_id, jobId);
      } catch (error) {
        this.logger.error("failed to record upload-job reference; sweep protection for this job's staging is degraded", {
          job_id: jobId,
          upload_id: manifest.upload_id,
          error: error instanceof Error ? error : String(error),
        });
      }
    }
    return { jobId, buildLogToken };
  }

  private dedupQuestion(
    dryRun: boolean,
    manifest: SubmittedSourceManifest
  ): {
    updatedSince: Date;
    dryRun: boolean;
    visibility: "public" | "private";
    sourceSha256: string;
  } {
    const staleMs = this.configService.get("activeJobDedupStaleMs", {
      infer: true,
    });
    return {
      updatedSince: new Date(Date.now() - staleMs),
      dryRun,
      visibility: declaredVisibility(manifest),
      sourceSha256: manifest.source_sha256,
    };
  }

  private chainReaderConfig(): ChainReaderConfig {
    return {
      stellarCliPath: this.configService.get("stellarCliPath", { infer: true }),
      artifactDir: this.configService.get("artifactDir", { infer: true }),
      cliTimeoutMs: this.configService.get("cliTimeoutMs", { infer: true }),
      mainnetRpcUrl: this.configService.get("mainnetRpcUrl", { infer: true }),
    };
  }
}
