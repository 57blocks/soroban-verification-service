import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createS3Client, getObjectBytesBounded, getObjectTextBounded, putObjectText } from "@scvs/aws";
import { JobsRepository, RebuildsRepository, type RebuildRecord } from "@scvs/db";
import {
  ARTIFACT_SCHEMA_UNSUPPORTED,
  ARTIFACT_UNREADABLE,
  BuildArtifact as BuildArtifactDto,
  ScvsLogger,
  flattenValidationErrors,
  probeBuildArtifactDocument,
  safeParseDto,
} from "@scvs/core";
import { buildLogKey, canonicalSourceKey, rebuiltWasmKey, recipeArtifactKey } from "../../common/staging-keys.util.js";
import { MAX_ARCHIVE_BYTES } from "../publish/fetch-source-bytes.util.js";
import type { AppConfigService } from "../../config/configuration.js";

/** The ceiling on `recipe.json`. */
const MAX_ARTIFACT_BYTES = 1024 * 1024;

export type RebuildOutcome = {
  outcome: "success" | "comparison_mismatch" | "cli_failure";
  runner?: string;
  rebuiltWasmHash?: string;
  exitCode: number | null;
  errorCode?: string;
  diagnostics?: unknown;
  canonicalSourceSha256?: string;
  canonicalSourceKey?: string;
  sourceCanonicalisation?: unknown;
  verifyFailureCode?: string;
};

/** The one place that turns "the builder's `recipe.json`" into "this rebuild's recorded outcome". */
@Injectable()
export class RebuildOutcomeService {
  private readonly logger = new ScvsLogger("rebuild-outcome");

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    // Injected rather than routed through the caller so the key lands in the same step that writes the object
    // it names.
    @Inject(JobsRepository) private readonly jobs: JobsRepository
  ) {}

  /** Records the outcome for a rebuild whose Batch job is known to have reached a terminal state. */
  async recordFromBatchTerminalState(
    rebuild: RebuildRecord,
    event: { status: string; statusReason?: string }
  ): Promise<RebuildOutcome> {
    const artifact = await this.readArtifact(rebuild);

    if (!artifact) {
      const { bucket } = this.configService.get("stagingStorage", { infer: true });
      this.logger.warn(
        "no build artifact found; synthesising a cli_failure from the Batch event",
        {
          rebuild_id: rebuild.rebuildId,
          staging_bucket: bucket,
          artifact_key: this.artifactKey(rebuild),
          batch_status: event.status,
        },
      );
      return this.record(rebuild, {
        outcome: "cli_failure",
        exitCode: null,
        errorCode: "batch_job_failed_no_artifact",
        diagnostics: {
          stderr_excerpt:
            event.statusReason ||
            `The Batch job (${event.status}) finished without uploading a build artifact.`,
        },
      });
    }

    return this.record(rebuild, artifact);
  }

  /** Records the outcome **only** if the builder's artifact is there to read, and reports whether it was. */
  async tryRecordFromArtifact(rebuild: RebuildRecord): Promise<boolean> {
    const artifact = await this.readArtifact(rebuild);
    if (!artifact) return false;
    await this.record(rebuild, artifact);
    return true;
  }

  private artifactKey(rebuild: RebuildRecord): string {
    return recipeArtifactKey(rebuild.rebuildId, rebuild.buildMode ?? "verify");
  }

  /**
   * Bounded before it is buffered: the object is written by untrusted code through a presigned PUT, so its size
   * is the submitter's choice.
   */
  private async hashUploadedArtifact(
    rebuild: RebuildRecord
  ): Promise<
    | { ok: true; hash: string; size: number }
    | { ok: false; reason: "absent" | "too_large"; detail: string }
  > {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const maxBytes = this.configService.get("maxRebuiltWasmBytes", { infer: true });
    const key = rebuiltWasmKey(rebuild.rebuildId, rebuild.buildMode ?? "verify");
    const s3 = createS3Client({ region: staging.region });

    const object = await getObjectBytesBounded(s3, staging.bucket, key, maxBytes);
    if (!object) {
      return {
        ok: false,
        reason: "absent",
        detail:
          `No rebuilt Wasm at ${key}. The builder reported a completed rebuild, so either its upload ` +
          "was lost or the object was removed before it could be hashed.",
      };
    }
    if ("tooLarge" in object) {
      return {
        ok: false,
        reason: "too_large",
        detail:
          `The rebuilt Wasm at ${key} is ${object.tooLarge} bytes, over the ${maxBytes}-byte ceiling ` +
          "(SCVS_MAX_REBUILT_WASM_BYTES), so it was not read.",
      };
    }

    return {
      ok: true,
      hash: createHash("sha256").update(object.bytes).digest("hex"),
      size: object.size,
    };
  }

  /**
   * Called only when the artifact says bytes were uploaded, which is only when the archive built from is not
   * the submitted one — a container was peeled, or a rebuilt archive was adopted.
   */
  private async hashCanonicalSource(
    rebuild: RebuildRecord
  ): Promise<
    | { ok: true; hash: string; key: string }
    | { ok: false; reason: "absent" | "too_large"; key: string; detail: string }
  > {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const maxBytes = MAX_ARCHIVE_BYTES;
    const key = canonicalSourceKey(rebuild.rebuildId, rebuild.buildMode ?? "verify");
    const s3 = createS3Client({ region: staging.region });

    const object = await getObjectBytesBounded(s3, staging.bucket, key, maxBytes);
    if (!object) {
      return {
        ok: false,
        reason: "absent",
        key,
        detail:
          `No canonical source archive at ${key}, though the builder reported uploading one. Either ` +
          "the upload was lost or the object was removed before it could be hashed.",
      };
    }
    if ("tooLarge" in object) {
      return {
        ok: false,
        reason: "too_large",
        key,
        detail:
          `The canonical source archive at ${key} is ${object.tooLarge} bytes, over the ` +
          `${maxBytes}-byte ceiling this service holds source archives to, so it was not read.`,
      };
    }
    return { ok: true, hash: createHash("sha256").update(object.bytes).digest("hex"), key };
  }

  /** Writes the build log to its own object and records the key on every job attached to this rebuild. */
  private async publishBuildLog(rebuild: RebuildRecord, log: string | undefined): Promise<void> {
    if (!log) return;
    const staging = this.configService.get("stagingStorage", { infer: true });
    const key = buildLogKey(rebuild.rebuildId, rebuild.buildMode ?? "build");
    try {
      const s3 = createS3Client({ region: staging.region });
      await putObjectText(s3, staging.bucket, key, log, "text/plain; charset=utf-8");
      // The expiry is written with the key, in one statement: a key without one is a log retained
      // indefinitely, which is the state the build-log access model exists to end (build-log-access
      // design.md BL-2).
      const retentionMs = this.configService.get("buildLogRetentionMs", { infer: true });
      const expiresAt = new Date(Date.now() + retentionMs);
      const jobs = await this.jobs.recordBuildLogKeyForRebuild(rebuild.rebuildId, key, expiresAt);
      this.logger.log("build log stored", {
        rebuild_id: rebuild.rebuildId,
        object_key: key,
        jobs,
        expires_at: expiresAt.toISOString(),
      });
    } catch (error) {
      this.logger.warn("could not store the build log for this rebuild", {
        rebuild_id: rebuild.rebuildId,
        object_key: key,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /** Reads `staging/{rebuildId}/{mode}/recipe.json` and maps it onto a `RebuildOutcome`. */
  private async readArtifact(
    rebuild: RebuildRecord
  ): Promise<RebuildOutcome | undefined> {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    // `getObjectText` would buffer all of it. `tooLarge` is deliberately not folded into the `undefined` arm.
    const object = await getObjectTextBounded(s3, staging.bucket, this.artifactKey(rebuild), MAX_ARTIFACT_BYTES);
    if (!object) return undefined;
    if ("tooLarge" in object) {
      this.logger.error("recipe.json exceeds the readable ceiling; treating the attempt as artifactless", {
        rebuild_id: rebuild.rebuildId,
        declared_bytes: object.tooLarge,
        max_bytes: MAX_ARTIFACT_BYTES,
      });
      return undefined;
    }

    // Neither of the two paths into this service may throw on a document it cannot use.
    const probe = probeBuildArtifactDocument(object.text);
    if (probe.kind === "unreadable") {
      return this.unusableArtifact(rebuild, ARTIFACT_UNREADABLE, `recipe.json is ${probe.detail}.`);
    }
    if (probe.kind === "unsupported") {
      return this.unusableArtifact(
        rebuild,
        ARTIFACT_SCHEMA_UNSUPPORTED,
        `recipe.json declares schema_version ${probe.declared}; this orchestrator reads ` +
          `${probe.supported}. Deploy this environment's orchestrator before its builder.`,
        { declared_schema_version: probe.declared, supported_schema_version: probe.supported },
      );
    }

    const validated = safeParseDto(BuildArtifactDto, probe.document);
    if (!validated.success) {
      // Same version, unusable document: the builder is out of contract or the sandbox wrote something else.
      return this.unusableArtifact(
        rebuild,
        ARTIFACT_UNREADABLE,
        "recipe.json does not conform to the build-artifact contract it declares.",
        {
          declared_schema_version: probe.declared,
          invalid_properties: flattenValidationErrors(validated.errors)
            .map((issue) => issue.property)
            .sort(),
        },
      );
    }
    const artifact = validated.data;
    // Best-effort and after the parse — a log that cannot be written must not cost the outcome the artifact
    // carries.
    await this.publishBuildLog(rebuild, artifact.build_log);
    if (artifact.classification === "cli_failure") {
      // Logged in full here because `failure_context` deliberately does NOT go into `rebuild.diagnostics`: that
      // column is read back as a `SandboxDiagnostics` and validated when the artifact is published, so an
      // arbitrary shape there would fail publication.
      this.logger.warn("builder reported cli_failure", {
        rebuild_id: rebuild.rebuildId,
        reason: artifact.reason,
        failure_context_keys: artifact.failure_context
          ? Object.keys(artifact.failure_context).sort()
          : undefined,
      });
    }

    // Everything above this point is the sandbox's account of what happened; the hash below is ours.
    const hashed =
      artifact.classification === "cli_failure" ? undefined : await this.hashUploadedArtifact(rebuild);

    if (hashed && !hashed.ok) {
      // **Fails closed.** A rebuild that claims to have produced bytes we cannot hash yields no verdict
      // Recorded as a `cli_failure` so every attached job takes the ordinary "this recipe cannot produce bytes"
      // path (`verification-pipeline.service.ts`'s `settle`) instead of each inventing its own handling.
      this.logger.error("rebuilt bytes could not be hashed; refusing to verdict from the reported hash", {
        rebuild_id: rebuild.rebuildId,
        reason: hashed.reason,
        detail: hashed.detail,
        sandbox_reported_wasm_hash: artifact.rebuilt_wasm_hash,
        sandbox_claimed_upload: artifact.rebuilt_wasm_uploaded ?? false,
      });
      return {
        outcome: "cli_failure",
        runner: artifact.runner,
        exitCode: artifact.exit_code,
        errorCode: `rebuilt_bytes_${hashed.reason}`,
        // `runner` first so the shape stays a valid `SandboxDiagnostics` even when the artifact carried none.
        diagnostics: {
          runner: artifact.runner,
          ...(artifact.diagnostics ?? {}),
          stderr_excerpt: hashed.detail,
        },
      };
    }

    if (hashed?.ok && artifact.rebuilt_wasm_hash && artifact.rebuilt_wasm_hash !== hashed.hash) {
      // **The attack, observed.** Deliberately not a failure: the bytes are the bytes, so the lie
      // changes nothing about the verdict — which is the property T7 asserts.
      this.logger.error(
        "the sandbox reported a hash that disagrees with the bytes it uploaded; using the bytes",
        {
          rebuild_id: rebuild.rebuildId,
          sandbox_reported_wasm_hash: artifact.rebuilt_wasm_hash,
          trusted_wasm_hash: hashed.hash,
          rebuilt_wasm_size_bytes: hashed.size,
        },
      );
    }

    // Unlike the Wasm-hash check, this service has no independent re-fetch of the source archive to compare
    // against, so a disagreement between two already-checked values is treated as a genuine anomaly and fails
    // the rebuild closed.
    if (
      artifact.classification !== "cli_failure" &&
      artifact.source_sha256 &&
      rebuild.sourceRef.source_sha256 &&
      artifact.source_sha256 !== rebuild.sourceRef.source_sha256
    ) {
      this.logger.error(
        "the sandbox's source archive hash disagrees with the source recorded for this rebuild",
        {
          rebuild_id: rebuild.rebuildId,
          sandbox_reported_source_sha256: artifact.source_sha256,
          recorded_source_sha256: rebuild.sourceRef.source_sha256,
        },
      );
      return {
        outcome: "cli_failure",
        runner: artifact.runner,
        exitCode: artifact.exit_code,
        errorCode: "source_sha256_mismatch",
        diagnostics: {
          runner: artifact.runner,
          ...(artifact.diagnostics ?? {}),
          stderr_excerpt:
            "The build sandbox's own hash of the source archive it built from does not match the " +
            "source recorded for this verification. Refusing to publish an unverified provenance.",
        },
      };
    }

    const canonical = artifact.source_canonicalisation;
    let canonicalSource: { canonicalSourceSha256?: string; canonicalSourceKey?: string } = {};
    if (canonical?.uploaded) {
      const fetched = await this.hashCanonicalSource(rebuild);
      if (!fetched.ok) {
        // **Fails closed**, the same way an unhashable rebuilt Wasm does. The sandbox said it uploaded
        // bytes and there are none, which is an anomaly rather than a degradation.
        this.logger.error("the canonical source archive could not be hashed", {
          rebuild_id: rebuild.rebuildId,
          reason: fetched.reason,
          detail: fetched.detail,
          sandbox_reported_canonical_sha256: canonical.canonical_sha256,
        });
        return {
          outcome: "cli_failure",
          runner: artifact.runner,
          exitCode: artifact.exit_code,
          errorCode: "source_archive_canonical_unavailable",
          diagnostics: {
            runner: artifact.runner,
            ...(artifact.diagnostics ?? {}),
            stderr_excerpt: fetched.detail,
          },
          sourceCanonicalisation: canonical,
        };
      }
      if (canonical.canonical_sha256 && canonical.canonical_sha256 !== fetched.hash) {
        // The same alarm as the Wasm's, for the same reason and with the same resolution: nothing legitimate
        // produces it, and the bytes win.
        this.logger.error(
          "the sandbox reported a canonical source hash that disagrees with the bytes it uploaded; using the bytes",
          {
            rebuild_id: rebuild.rebuildId,
            sandbox_reported_canonical_sha256: canonical.canonical_sha256,
            trusted_canonical_sha256: fetched.hash,
          },
        );
      }
      canonicalSource = { canonicalSourceSha256: fetched.hash, canonicalSourceKey: fetched.key };
    }

    return {
      outcome: artifact.classification,
      runner: artifact.runner,
      ...(artifact.verify_attempt_reason
        ? { verifyFailureCode: artifact.verify_attempt_reason }
        : {}),
      ...canonicalSource,
      ...(canonical ? { sourceCanonicalisation: canonical } : {}),
      // Present on success AND on comparison_mismatch: a mismatch's bytes are just as real and just as
      // shareable, and a *different* target attached to this rebuild may well match them.
      ...(hashed?.ok ? { rebuiltWasmHash: hashed.hash } : {}),
      exitCode: artifact.exit_code,
      // `docker_error` first (the most specific thing the sandbox path knows), then the builder's own reason
      // code, and only then the useless generic.
      ...(artifact.classification === "cli_failure"
        ? {
            errorCode:
              artifact.diagnostics?.docker_error || artifact.reason || "cli_failure",
          }
        : {}),
      ...(artifact.diagnostics ? { diagnostics: artifact.diagnostics } : {}),
    };
  }

  /** The one terminal outcome for "the bytes are there and we cannot use them". */
  private unusableArtifact(
    rebuild: RebuildRecord,
    errorCode: string,
    detail: string,
    context: Record<string, unknown> = {},
  ): RebuildOutcome {
    this.logger.error("recipe.json could not be used; failing the rebuild with a visible reason", {
      rebuild_id: rebuild.rebuildId,
      error_code: errorCode,
      artifact_key: this.artifactKey(rebuild),
      detail,
      ...context,
    });
    return {
      outcome: "cli_failure",
      exitCode: null,
      errorCode,
      diagnostics: { stderr_excerpt: detail },
    };
  }

  private async record(
    rebuild: RebuildRecord,
    outcome: RebuildOutcome
  ): Promise<RebuildOutcome> {
    this.logger.log("rebuild outcome recorded", {
      rebuild_id: rebuild.rebuildId,
      build_mode: rebuild.buildMode ?? "verify",
      outcome: outcome.outcome,
      exit_code: outcome.exitCode,
      rebuilt_wasm_hash: outcome.rebuiltWasmHash,
      // Absent means the canonical archive is the submitted one, which is the ordinary case.
      canonical_source_sha256: outcome.canonicalSourceSha256,
    });

    await this.rebuilds.markTerminal(rebuild.rebuildId, {
      outcome: outcome.outcome,
      ...(outcome.runner ? { runner: outcome.runner } : {}),
      ...(outcome.rebuiltWasmHash
        ? { rebuiltWasmHash: outcome.rebuiltWasmHash }
        : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
      ...(outcome.canonicalSourceSha256
        ? { canonicalSourceSha256: outcome.canonicalSourceSha256 }
        : {}),
      ...(outcome.canonicalSourceKey ? { canonicalSourceKey: outcome.canonicalSourceKey } : {}),
      ...(outcome.sourceCanonicalisation
        ? { sourceCanonicalisation: outcome.sourceCanonicalisation }
        : {}),
      ...(outcome.verifyFailureCode ? { verifyFailureCode: outcome.verifyFailureCode } : {}),
    });

    // Every attached job picks this up on the next poll tick (default 2s) and resolves its own verdict.
    this.logger.log("attached jobs will resolve on the next poll tick", {
      rebuild_id: rebuild.rebuildId,
      outcome: outcome.outcome,
    });
    return outcome;
  }
}
