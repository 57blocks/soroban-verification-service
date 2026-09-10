import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  BatchJobParams,
  ScvsLogger,
  extractManifestPath,
  runWithLogContext,
  stderrOnlySink,
  type BuildRecipe,
} from "@scvs/core";
import { handoffPath, readHandoff } from "./handoff.js";
import { jobParamsInput, readJobParams } from "./job-params.js";
import {
  runCli,
  type RunCliResult,
  type RunCliRuntimeConfig,
} from "./run-cli.js";
import { extractBuildPackage } from "./build-options.js";
import { buildRecipeArtifact } from "./recipe.js";
import { uploadRebuiltWasm, uploadRecipeArtifact } from "./upload.js";
import type { AppConfigService } from "../../config/configuration.js";

type Classification =
  | "success"
  | "built"
  | "comparison_mismatch"
  | "cli_failure"
  | "fatal";

const EXIT_CODES: Record<Classification, number> = {
  success: 0,
  built: 0,
  comparison_mismatch: 1,
  cli_failure: 2,
  fatal: 3,
};

export type BuilderRunResult = {
  classification: Classification;
  exitCode: number;
  /** The single structured JSON line entrypoint.ts writes to stdout as its last line. */
  line: Record<string, unknown>;
};

/**
 * It receives an already-materialised, already-extracted source tree through the handoff document
 * `MaterialiseService` wrote in its own socket-less container, and does nothing but assemble and run container
 * commands.
 */
@Injectable()
export class BuilderService {
  // Explicit `@Inject()` — see build-dispatch.scheduler.ts's comment.
  private readonly logger = new ScvsLogger("builder", { sink: stderrOnlySink });

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService
  ) {}

  async run(): Promise<BuilderRunResult> {
    let job: BatchJobParams;
    try {
      job = await readJobParams(
        BatchJobParams,
        jobParamsInput(
          this.configService.get("jobParamsUrl", { infer: true }),
          this.configService.get("jobParamsJson", { infer: true }),
        ),
      );
    } catch (error) {
      return this.emitFatal(
        undefined,
        undefined,
        `Failed to read/parse BatchJobParams: ${describeError(error)}`
      );
    }

    // O2: `job_id` is this run's correlation identifier, and it needs no plumbing — it arrives on
    // `BatchJobParams` and the trusted side reads it back off `recipe.json`.
    return runWithLogContext({ job_id: job.job_id, mode: job.mode }, () =>
      this.runForJob(job)
    );
  }

  private async runForJob(job: BatchJobParams): Promise<BuilderRunResult> {
    this.logger.log("rebuild starting", { source_ref_type: job.source_ref.type });

    const path = handoffPath(this.handoffRoot(), job.job_id);
    let handoff: Awaited<ReturnType<typeof readHandoff>>;
    try {
      handoff = await readHandoff(path);
    } catch (error) {
      // Not a source problem: the materialiser container did not run, or ran somewhere this container cannot
      // see.
      const detail =
        `No readable source handoff at ${path}: ${describeError(error)}. The materialiser container ` +
        `must run first and share a host-mounted path with this one — see handoff.ts.`;
      // The params are parsed and `job.upload_url` is in hand, so the artifact can still go out — unlike the
      // `run()`-level fatal for unparseable params, which has no URL and is the honest exception.
      await this.uploadLogOnlyArtifact(job, detail);
      return this.emitFatal(job.job_id, job.mode, detail);
    }

    if (!handoff.ok) {
      // The materialiser reported an unfetchable source and exited 0 on purpose, so that this runs and the
      // trusted side gets the precise reason rather than a synthesised `no_artifact`.
      return this.finish(job, {
        outcome: "cli_failure",
        runner: "docker_build_image_rebuild",
        exit_code: null,
        reason: handoff.reason,
        diagnostics: {
          stage: "fetch-source",
          status: handoff.status,
          reason: handoff.reason,
          detail: handoff.detail,
        },
      });
    }

    const result = await runCli({
      mode: job.mode,
      target: job.target,
      build: buildRecipeFromJob(job),
      source: handoff.source,
      config: this.runCliConfig(),
    });

    return this.finish(job, result);
  }

  /** Must match the materialiser's, and must be a real path on the host — see handoff.ts. */
  private handoffRoot(): string {
    return this.configService.get("handoffRoot", { infer: true }) || tmpdir();
  }

  private runCliConfig(): RunCliRuntimeConfig {
    return {
      cliTimeoutMs: this.configService.get("cliTimeoutMs", { infer: true }),
      dependencyPrefetchTimeoutMs: this.configService.get("dependencyPrefetchTimeoutMs", { infer: true }),
      dockerCheckTimeoutMs: this.configService.get("dockerCheckTimeoutMs", { infer: true }),
      dockerHost: this.configService.get("dockerHost", { infer: true }),
      prefetchAllowedHosts: this.configService.get("prefetchAllowedHosts", { infer: true }),
      dockerCpus: this.configService.get("dockerCpus", { infer: true }),
      dockerMemory: this.configService.get("dockerMemory", { infer: true }),
      dockerPidsLimit: this.configService.get("dockerPidsLimit", { infer: true }),
      dockerUser: this.configService.get("dockerUser", { infer: true }),
    };
  }

  private async finish(
    job: BatchJobParams,
    result: RunCliResult
  ): Promise<BuilderRunResult> {
    // Ordering matters for the same reason: dying between the two uploads leaves no `recipe.json`, and a
    // missing `recipe.json` is already treated as a failed attempt.
    const uploadedWasm = await this.uploadRebuiltBytes(job, result);
    if (uploadedWasm.ok === false) {
      return this.emitFatal(
        job.job_id,
        job.mode,
        uploadedWasm.detail,
        result.exit_code
      );
    }

    const recipe = buildRecipeArtifact(
      buildRecipeFromJob(job),
      result,
      uploadedWasm.uploaded
    );

    const upload = await uploadRecipeArtifact(job.upload_url, recipe);
    if (!upload.ok) {
      return this.emitFatal(
        job.job_id,
        job.mode,
        `Failed to upload recipe.json: ${upload.detail}`,
        result.exit_code
      );
    }

    const classification: Classification =
      result.outcome === "verified"
        ? "success"
        : result.outcome === "built"
          ? "built"
          : result.outcome === "comparison_mismatch"
            ? "comparison_mismatch"
            : "cli_failure";

    return this.emit(classification, {
      job_id: job.job_id,
      mode: job.mode,
      runner: result.runner,
      exit_code: result.exit_code,
      reason: result.reason,
      rebuilt_wasm_hash: result.rebuilt_wasm_hash,
      rebuilt_wasm_size_bytes: result.rebuilt_wasm_size_bytes,
    });
  }

  /** Sends the rebuilt Wasm to its own presigned target, when this attempt produced one. */
  private async uploadRebuiltBytes(
    job: BatchJobParams,
    result: RunCliResult
  ): Promise<{ ok: true; uploaded: boolean } | { ok: false; detail: string }> {
    if (!result.rebuilt_wasm_path) {
      return { ok: true, uploaded: false };
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(result.rebuilt_wasm_path);
    } catch (error) {
      return {
        ok: false,
        detail:
          `Failed to read the rebuilt Wasm at ${result.rebuilt_wasm_path} for upload: ` +
          `${describeError(error)}. The build reported this artifact, so it must still be there.`,
      };
    }

    const upload = await uploadRebuiltWasm(job.artifact_upload_url, bytes);
    if (!upload.ok) {
      return { ok: false, detail: `Failed to upload the rebuilt Wasm: ${upload.detail}` };
    }

    this.logger.log("rebuilt Wasm uploaded for trusted-side hashing", {
      size_bytes: bytes.byteLength,
      // The sandbox's own hash, for comparison against the one the orchestrator is about to compute.
      self_hashed_sha256: result.rebuilt_wasm_hash,
    });
    return { ok: true, uploaded: true };
  }

  /**
   * Uploads a `recipe.json` whose only payload is the build log, for a terminal path that produced no
   * `RunCliResult` to build a real artifact from.
   */
  private async uploadLogOnlyArtifact(job: BatchJobParams, detail: string): Promise<void> {
    try {
      const artifact = buildRecipeArtifact(buildRecipeFromJob(job), {
        outcome: "cli_failure",
        runner: "docker_build_image_rebuild",
        exit_code: null,
        reason: "handoff_unreadable",
        diagnostics: { detail },
      });
      const upload = await uploadRecipeArtifact(job.upload_url, artifact);
      if (!upload.ok) {
        this.logger.warn("could not upload the build log for a fatal outcome", { detail: upload.detail });
      }
    } catch (error) {
      this.logger.warn("could not assemble the build log for a fatal outcome", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private emitFatal(
    job_id: string | undefined,
    mode: string | undefined,
    detail: string,
    exit_code: number | null = null
  ): BuilderRunResult {
    return this.emit("fatal", { job_id, mode, exit_code, detail });
  }

  private emit(
    classification: Classification,
    extra: Record<string, unknown>
  ): BuilderRunResult {
    // The one terminal record. `extra` is deliberately NOT spread into it: it is a `Record<string, unknown>`
    // assembled from job params and diagnostics, exactly the shape the kernel refuses to accept as fields.
    this.logger.log("rebuild finished", {
      classification,
      process_exit_code: EXIT_CODES[classification],
      ...(typeof extra.exit_code === "number"
        ? { command_exit_code: extra.exit_code }
        : {}),
    });

    return {
      classification,
      exitCode: EXIT_CODES[classification],
      line: {
        schema: "scvs-builder-entrypoint-result-v1",
        classification,
        ...extra,
      },
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The two tests covering this asserted the wrong meaning, which is why nothing caught it. */
export function buildRecipeFromJob(
  job: Pick<BatchJobParams, "image_digest" | "build_args" | "build_options" | "metadata_replay">,
): BuildRecipe {
  const bldopt = job.build_options ?? [];
  const packageName = extractBuildPackage(bldopt);
  return {
    image: job.image_digest,
    workspace_path: extractManifestPath(bldopt) ?? ".",
    target: "wasm32v1-none",
    bldarg: job.build_args ?? [],
    bldopt,
    ...(job.metadata_replay?.length ? { metadata_replay: job.metadata_replay } : {}),
    ...(packageName ? { package: packageName } : {}),
  };
}
