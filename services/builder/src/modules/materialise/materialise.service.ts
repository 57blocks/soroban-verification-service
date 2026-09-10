import { mkdtemp, readFile, stat } from "node:fs/promises";
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
import { sha256File } from "../builder/process-utils.js";
import { uploadArtifact } from "../builder/upload.js";
import { jobParamsInput, readJobParams } from "../builder/job-params.js";
import { toMaterializeSourceInput } from "../builder/materialize-input.js";
import type { AppConfigService } from "../../config/configuration.js";

/** It downloads, clones and extracts, then writes a handoff document and exits. */
/** The materialiser's own bound on a `tar` listing, independent of the CLI's 600s budget. */
const TAR_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * A limit only counts when it is a positive number. `@IsNumberString` accepts `0` and `-1`, and `??` would pass
 * either straight through.
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The refusal for an archive that is not the one the deployed Wasm records — pure, so its wording is testable
 * without a filesystem.
 */
function chainSourceRefusal(hashes: { expected: string; canonical: string; depth: number }): {
  ok: false;
  reason: string;
  status: string;
  detail: string;
} {
  // A peel happened, so the hash being reported is one the submitter never computed — name the file it came
  // from, or the number reads as though we hashed something else than what they sent.
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

  /** Exit code. Non-zero means a crash — a source that cannot be fetched is a successful `ok: false`. */
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
      // Always 0 on a written handoff: `dependsOn: SUCCESS` gates the runner, and a non-zero exit here would
      // stop it from ever emitting the `cli_failure` artifact the trusted side reads.
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

    // Peeling and extraction, both out of the runner. The runner now requires a directory for the build path
    // and says so loudly if it gets anything else — see run-cli.ts.
    const prepared = await this.prepareSource(result.source, job);
    if (!prepared.ok) {
      return {
        ok: false,
        schema: HANDOFF_SCHEMA,
        job_id: jobId,
        reason: prepared.reason,
        // The chain-source refusal below names its own status; everything else that fails in `prepareSource`
        // really is an extraction fault.
        status: prepared.status ?? "extraction_failed",
        detail: prepared.detail,
      };
    }

    return { ok: true, schema: HANDOFF_SCHEMA, job_id: jobId, source: prepared.source };
  }

  /** Turn what was fetched into the two things the runner needs: an extracted tree for the build path, and. */
  private async prepareSource(
    source: MaterializedSource,
    job: MaterialiseJobParams,
  ): Promise<
    | { ok: true; source: MaterializedSource }
    | { ok: false; reason: string; detail: string; status?: string }
  > {
    const info = await stat(source.workspace_path).catch(() => undefined);
    if (!info) {
      return {
        ok: false,
        reason: "source_path_not_found",
        detail: "The materialized source path no longer exists.",
      };
    }
    // A git checkout is already a tree: nothing to peel, and no archive for the verify path to hash.
    if (info.isDirectory()) return { ok: true, source };

    const extractRoot = await mkdtemp(join(this.handoffRoot(), "scvs-src-"));
    const limits = this.archiveLimits();
    // `extractCanonicalArchive` takes the runtime config only for its `tar` timeout; nothing else on it is read
    // here, and this container has no runtime to configure.
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
        // Already read by the peel, on this exact archive — see CanonicaliseResult.listing.
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

      // Depth 0 means the canonical archive IS the submitted archive, whose hash the trusted side has already
      // verified.
      const differsFromSubmitted = canonical.canonicalisation.depth > 0;
      const uploaded = differsFromSubmitted
        ? await this.uploadCanonicalArchive(canonicalPath, job.canonical_source_upload_url)
        : false;

      const record: SourceCanonicalisation = {
        depth: canonical.canonicalisation.depth,
        outer_format: canonical.canonicalisation.outer_format,
        canonical_format: canonical.canonicalisation.canonical_format,
        canonical_sha256: canonicalSha256,
        // Echoed so the record names what it compared against, and so the runner can tell the CLI's source-hash
        // refusal is coming without reading the CLI's prose for it.
        ...(expectedSourceSha256 ? { expected_source_sha256: expectedSourceSha256 } : {}),
        // The only two the gate above leaves reachable. `adopted`/`hash_mismatch`/`failed` stay in the contract
        // for rows already written; remapping them would rewrite their meaning.
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
          // Reported whenever it says something: a peel happened, or a rebuild was considered.
          ...(canonical.canonicalisation.depth > 0 || record.reconstruction !== "no_oracle"
            ? { canonicalisation: record }
            : {}),
        },
      };
    } finally {
      // The tree is out and any peeled archive has been adopted, so the intermediate levels have no reader
      // left.
      await canonical.dispose();
    }
  }

  /** PUT the canonical archive to the one write target this container is granted. */
  private async uploadCanonicalArchive(archivePath: string, uploadUrl?: string): Promise<boolean> {
    if (!uploadUrl) {
      // A dispatch that predates this field, or a local run with no staging.
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

  /** Move a peeled archive out of the peel staging and give it a name the CLI accepts. */
  private async adoptPeeledArchive(archivePath: string): Promise<string> {
    const root = artifactRoot(this.fetchSourceConfig());
    const adopted = await adoptArchive({ localPath: archivePath, artifactRoot: root }).catch(
      () => archivePath,
    );
    const aligned = await alignArchiveNameForCli({ localPath: adopted, artifactRoot: root });
    return aligned.path;
  }

  /** The shared mount both containers see at the same path, and which is a real path on the host. */
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

  /** Operator-tunable, like the compressed-size bound beside it. */
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
