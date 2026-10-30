import type { RebuildErrorCode } from "@scvs/core";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  MaterialiseJobParams,
  ScvsLogger,
  runWithLogContext,
  stderrOnlySink,
  type SourceCanonicalisation,
} from "@scvs/core";
import {
  canonicaliseSourceArchive,
  DEFAULT_ARCHIVE_LIMITS,
  extractCanonicalArchive,
  type ArchiveLimits,
} from "../builder/archive-extraction.js";
import { adoptArchive, alignArchiveNameForCli } from "../builder/archive-format.js";
import {
  artifactRoot,
  materializeSource,
  type FetchSourceConfig,
  type MaterializedSource,
  type MaterializeSourceInput,
} from "../builder/fetch-source.js";
import { handoffPath, writeHandoff, HANDOFF_SCHEMA, type SourceHandoff } from "../builder/handoff.js";
import { sha256File } from "@scvs/core/process";
import { uploadArtifact } from "../builder/upload.js";
import { jobParamsInput, readJobParams } from "../builder/job-params.js";
import { toMaterializeSourceInput } from "../builder/materialize-input.js";
import type { AppConfigService } from "../../config/configuration.js";

const TAR_TIMEOUT_DEFAULT_MS = 30_000;

/** `@IsNumberString` accepts `0` and `-1`, and `??` would pass either straight through. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function chainSourceRefusal(hashes: { expected: string; canonical: string; depth: number }): {
  ok: false;
  reason: RebuildErrorCode;
  status: string;
  detail: string;
} {
  const measured =
    hashes.depth > 0
      ? `the archive inside what you submitted hashes to ${hashes.canonical}`
      : `the archive you submitted hashes to ${hashes.canonical}`;
  return {
    ok: false,
    reason: "source_archive_not_chain_recorded",
    status: "source_hash_mismatch",
    detail:
      `This contract records source_sha256=${hashes.expected} on chain, but ${measured}, so the two ` +
      "are not the same source and verification stops here. Submit the exact archive the contract " +
      "was built from — byte for byte, in the format it was published in, since the recorded hash is " +
      "over those bytes and any repack changes it. The two usual causes are submitting a re-created " +
      "archive rather than the original, and an archive missing the project's `.gitignore`, whose " +
      "rules decide which files belong in it.",
  };
}

@Injectable()
export class MaterialiseService {
  private readonly logger = new ScvsLogger("materialise", { sink: stderrOnlySink });

  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  async run(): Promise<number> {
    const job = await readJobParams(
      MaterialiseJobParams,
      jobParamsInput(
        this.configService.get("jobParamsUrl", { infer: true }),
        this.configService.get("jobParamsJson", { infer: true }),
      ),
    );

    return runWithLogContext({ job_id: job.job_id, mode: job.mode }, async () => {
      const path = handoffPath(this.handoffRoot(), job.job_id);
      this.logger.log("materialising source", {
        source_ref_type: job.source_ref.type,
        handoff_path: path,
      });

      const handoff = await this.materialise(job.job_id, job);
      await writeHandoff(path, handoff);

      this.logger.log("handoff written", { ok: handoff.ok, handoff_path: path });
      // Always 0 on a written handoff: the runner starts only on SUCCESS and must still emit the `cli_failure` artifact.
      return 0;
    });
  }

  private async materialise(
    jobId: string,
    job: MaterialiseJobParams,
  ): Promise<SourceHandoff> {
    let input: MaterializeSourceInput;
    try {
      input = toMaterializeSourceInput(job.source_ref, this.fetchSourceConfig());
    } catch (error) {
      return {
        ok: false,
        schema: HANDOFF_SCHEMA,
        job_id: jobId,
        reason: "source_ref_unsupported",
        status: "unsupported",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const result = await materializeSource(input);
    if (!result.ok) {
      return {
        ok: false,
        schema: HANDOFF_SCHEMA,
        job_id: jobId,
        reason: result.reason,
        status: result.status,
        detail: result.detail,
      };
    }

    const prepared = await this.prepareSource(result.source, job);
    if (!prepared.ok) {
      return {
        ok: false,
        schema: HANDOFF_SCHEMA,
        job_id: jobId,
        reason: prepared.reason,
        status: prepared.status ?? "extraction_failed",
        detail: prepared.detail,
      };
    }

    return { ok: true, schema: HANDOFF_SCHEMA, job_id: jobId, source: prepared.source };
  }

  private async prepareSource(
    source: MaterializedSource,
    job: MaterialiseJobParams,
  ): Promise<
    | { ok: true; source: MaterializedSource }
    | { ok: false; reason: RebuildErrorCode; detail: string; status?: string }
  > {
    const info = await stat(source.workspace_path).catch(() => undefined);
    if (!info) {
      return {
        ok: false,
        reason: "source_path_not_found",
        detail: "The materialized source path no longer exists.",
      };
    }
    if (info.isDirectory()) return { ok: true, source };

    const extractRoot = await mkdtemp(join(this.handoffRoot(), "scvs-src-"));
    let handedOff = false;
    try {
      const prepared = await this.extractInto(extractRoot, source, job);
      handedOff = prepared.ok;
      return prepared;
    } finally {
      if (!handedOff) await rm(extractRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractInto(
    extractRoot: string,
    source: MaterializedSource,
    job: MaterialiseJobParams,
  ): Promise<
    | { ok: true; source: MaterializedSource }
    | { ok: false; reason: RebuildErrorCode; detail: string; status?: string }
  > {
    const limits = this.archiveLimits();
    const config = {
      cliTimeoutMs: this.configService.get("tarTimeoutMs", { infer: true }) ?? TAR_TIMEOUT_DEFAULT_MS,
    };

    const canonical = await canonicaliseSourceArchive({
      archivePath: source.workspace_path,
      stagePrefix: `${extractRoot}-peel-`,
      limits,
      config,
    });
    if (!canonical.ok) return canonical;

    try {
      const extracted = await extractCanonicalArchive({
        archivePath: canonical.archivePath,
        destRoot: extractRoot,
        listing: canonical.listing,
        // Charged, not reset: peeling has already spent part of the ceiling.
        limits: canonical.limits,
        config,
      });
      if (!extracted.ok) return extracted;

      let canonicalPath =
        canonical.canonicalisation.depth === 0
          ? source.workspace_path
          : await this.adoptPeeledArchive(canonical.archivePath);
      const canonicalSha256 = await sha256File(canonicalPath).then((hash) => hash.toLowerCase());

      const expectedSourceSha256 = job.expected_source_sha256?.toLowerCase();
      if (expectedSourceSha256 && expectedSourceSha256 !== canonicalSha256) {
        return chainSourceRefusal({
          expected: expectedSourceSha256,
          canonical: canonicalSha256,
          depth: canonical.canonicalisation.depth,
        });
      }

      const differsFromSubmitted = canonical.canonicalisation.depth > 0;
      const uploaded = differsFromSubmitted
        ? await this.uploadCanonicalArchive(canonicalPath, job.canonical_source_upload_url)
        : false;

      const record: SourceCanonicalisation = {
        depth: canonical.canonicalisation.depth,
        outer_format: canonical.canonicalisation.outer_format,
        canonical_format: canonical.canonicalisation.canonical_format,
        canonical_sha256: canonicalSha256,
        ...(expectedSourceSha256 ? { expected_source_sha256: expectedSourceSha256 } : {}),
        reconstruction: expectedSourceSha256 ? "not_attempted" : "no_oracle",
        uploaded,
      };
      this.logger.log("source canonicalised", {
        uploaded: record.uploaded,
        depth: record.depth,
        outer_format: record.outer_format,
        canonical_format: record.canonical_format,
        reconstruction: record.reconstruction,
        peeled: canonical.canonicalisation.peeled.map((entry) => entry.member),
      });

      return {
        ok: true,
        source: {
          ...source,
          workspace_path: extracted.source_root,
          canonical_path: canonicalPath,
          ...(canonical.canonicalisation.depth > 0 || record.reconstruction !== "no_oracle"
            ? { canonicalisation: record }
            : {}),
        },
      };
    } finally {
      await canonical.dispose();
    }
  }

  private async uploadCanonicalArchive(archivePath: string, uploadUrl?: string): Promise<boolean> {
    if (!uploadUrl) {
      this.logger.warn("no canonical-source upload target; the peeled archive stays in the sandbox");
      return false;
    }
    const bytes = await readFile(archivePath).catch(() => undefined);
    if (!bytes) {
      this.logger.error("canonical source archive could not be read for upload", {
        archive_path: archivePath,
      });
      return false;
    }
    const result = await uploadArtifact(uploadUrl, bytes, "application/octet-stream");
    if (!result.ok) {
      this.logger.error("canonical source archive upload failed", {
        status: result.status,
        detail: result.detail,
      });
      return false;
    }
    return true;
  }

  private async adoptPeeledArchive(archivePath: string): Promise<string> {
    const root = artifactRoot(this.fetchSourceConfig());
    const adopted = await adoptArchive({ localPath: archivePath, artifactRoot: root }).catch(
      () => archivePath,
    );
    const aligned = await alignArchiveNameForCli({ localPath: adopted, artifactRoot: root });
    return aligned.path;
  }

  private handoffRoot(): string {
    return this.configService.get("handoffRoot", { infer: true }) || tmpdir();
  }

  private fetchSourceConfig(): FetchSourceConfig {
    return {
      artifactDir: this.configService.get("artifactDir", { infer: true }),
      sourceFetchTimeoutMs: this.configService.get("sourceFetchTimeoutMs", { infer: true }),
      maxSourceArchiveBytes: this.configService.get("maxSourceArchiveBytes", { infer: true }),
    };
  }

  private archiveLimits(): ArchiveLimits {
    return {
      maxEntries: positiveOr(
        this.configService.get("maxSourceArchiveEntries", { infer: true }),
        DEFAULT_ARCHIVE_LIMITS.maxEntries,
      ),
      maxUncompressedBytes: positiveOr(
        this.configService.get("maxSourceArchiveUncompressedBytes", { infer: true }),
        DEFAULT_ARCHIVE_LIMITS.maxUncompressedBytes,
      ),
    };
  }
}
