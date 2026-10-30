import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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
import { handoffJobDir, handoffPath, readHandoff } from "./handoff.js";
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
  line: Record<string, unknown>;
};

@Injectable()
export class BuilderService {
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

    return runWithLogContext({ job_id: job.job_id, mode: job.mode }, () =>
      this.runForJob(job)
    );
  }

  private async runForJob(job: BatchJobParams): Promise<BuilderRunResult> {
    const workDirs: string[] = [];
    try {
      return await this.rebuild(job, workDirs);
    } finally {
      await this.removeWorkDirs(workDirs);
    }
  }

  private async rebuild(job: BatchJobParams, workDirs: string[]): Promise<BuilderRunResult> {
    this.logger.log("rebuild starting", { source_ref_type: job.source_ref.type });

    const path = handoffPath(this.handoffRoot(), job.job_id);
    const jobDir = handoffJobDir(this.handoffRoot(), job.job_id);
    if (jobDir) workDirs.push(jobDir);
    let handoff: Awaited<ReturnType<typeof readHandoff>>;
    try {
      handoff = await readHandoff(path);
    } catch (error) {
      const detail =
        `No readable source handoff at ${path}: ${describeError(error)}. The materialiser container ` +
        `must run first and share a host-mounted path with this one — see handoff.ts.`;
      await this.uploadLogOnlyArtifact(job, detail);
      return this.emitFatal(job.job_id, job.mode, detail);
    }

    if (!handoff.ok) {
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

    const sourceDir = materialisedSourceDir(this.handoffRoot(), handoff.source.workspace_path);
    if (sourceDir) workDirs.push(sourceDir);

    const result = await runCli({
      mode: job.mode,
      target: job.target,
      build: buildRecipeFromJob(job),
      source: handoff.source,
      config: this.runCliConfig(),
      workDirs,
    });

    return this.finish(job, result);
  }

  private handoffRoot(): string {
    return this.configService.get("handoffRoot", { infer: true }) || tmpdir();
  }

  private async removeWorkDirs(workDirs: string[]): Promise<void> {
    for (const dir of workDirs) {
      await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        this.logger.warn("could not remove a job work directory", {
          work_dir: dir,
          detail: describeError(error),
        });
      });
    }
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
    // Wasm first: dying between the two uploads must leave no `recipe.json`, which already reads as a failed attempt.
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
      self_hashed_sha256: result.rebuilt_wasm_hash,
    });
    return { ok: true, uploaded: true };
  }

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
    // Never spread `extra` into this record: it is an untyped bag of job params and diagnostics.
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

function materialisedSourceDir(handoffRoot: string, workspacePath: string): string | undefined {
  if (!workspacePath) return undefined;
  const [top] = relative(handoffRoot, workspacePath).split(sep);
  return top?.startsWith("scvs-src-") ? join(handoffRoot, top) : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
