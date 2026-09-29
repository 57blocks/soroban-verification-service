import type {
  BuildMode,
  ComposedEnvironmentRecipe,
  MechanismReason,
  PublishedBuildRecipe,
  SandboxDiagnostics as SandboxDiagnosticsDto,
} from "@scvs/core";
import type { JobRecord } from "@scvs/db";
import { parseDto, type VerificationResultSummary as VerificationResultSummaryDto } from "@scvs/core";
import { VerificationArtifact as VerificationArtifactDto } from "@scvs/storage-layout";

export type VerifierIdentity = { id: string; displayName: string; policyId: string };

export type PublishedBuildEnvironment =
  | {
      kind: "chain_named";
      trustLevel: "official_trusted";
      buildImage: string;
    }
  | {
      kind: "composed";
      trustLevel: "upstream_pinned";
      buildImage: string;
      recipeSha256: string;
      imageDigest: string;
      recipe: ComposedEnvironmentRecipe;
    };

export function toBuildIsolation(buildMode: BuildMode): "network_isolated" | "cli_managed" {
  return buildMode === "verify" ? "cli_managed" : "network_isolated";
}

export function recipeSourceFor(reason: MechanismReason): "on_chain_metadata" | "submitted" {
  switch (reason) {
    case "on_chain_recipe_in_trusted_image":
    case "image_not_policy_accepted":
      return "on_chain_metadata";
    case "no_chain_recorded_image":
    case "environment_is_composed":
    case "recipe_deviates_from_chain":
      return "submitted";
  }
}

export function observeSep55Marker(buildOptions: unknown): boolean {
  const entries = (buildOptions as { metadata_replay?: unknown } | undefined)?.metadata_replay;
  if (!Array.isArray(entries)) return false;
  // A section can carry several source_repo entries; check every one, not just the first.
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    if (entry.slice(0, eq) !== "source_repo") continue;
    if (entry.slice(eq + 1).startsWith("github:")) return true;
  }
  return false;
}

export function assembleArtifact(
  job: JobRecord,
  verifier: VerifierIdentity,
  buildIsolation: "network_isolated" | "cli_managed",
  buildEnvironment: PublishedBuildEnvironment,
  sourceFileName: string | undefined,
  mechanismReason: MechanismReason,
  canonicalSourceSha256?: string,
  chainSourceSha256?: string,
): VerificationArtifactDto {
  const result = requireResult(job);
  return parseDto(VerificationArtifactDto, {
    schema: "stellar-verification-artifact-v1" as const,
    verifier: { id: verifier.id, policy_id: verifier.policyId },
    provenance: {
      recipe_source: recipeSourceFor(mechanismReason),
      build_isolation: buildIsolation,
    },
    trust: { sep55_attestation_present: observeSep55Marker(job.buildOptions) },
    source: {
      source_sha256: canonicalSourceSha256 ?? requireSourceSha256(job),
      is_public: job.sourceRef.visibility === "public",
      ...(sourceFileName ? { source_file_name: sourceFileName } : {}),
      // The persisted ref: the submitter's declared source_uri, never a presigned URL.
      ...(job.sourceRef.source_uri ? { source_uri: job.sourceRef.source_uri } : {}),
      ...(chainSourceSha256 ? { chain_source_sha256: chainSourceSha256 } : {}),
    },
    result: publishedResult(result),
    image_trust_level: buildEnvironment.trustLevel,
    build_recipe: buildRecipeRecord(job, buildEnvironment),
  } satisfies VerificationArtifactDto);
}

function publishedResult(result: VerificationResultSummaryDto): VerificationResultSummaryDto {
  if (!result.sandbox_diagnostics) return result;
  return { ...result, sandbox_diagnostics: publishedDiagnostics(result.sandbox_diagnostics) };
}

// The Registry's bldopt pattern needs one --flag per element, with = for a value.
export function toBldopt(buildOptions: unknown): string[] | undefined {
  const stored = buildOptions as { bldopt?: string[] } | undefined;
  return scrubInternalEnvBldopt(normaliseBldopt(stored?.bldopt));
}

// Order-significant: passed through exactly as the recipe records it.
export function toBldarg(buildOptions: unknown): string[] | undefined {
  const stored = buildOptions as { bldarg?: unknown } | undefined;
  const bldarg = stored?.bldarg;
  return Array.isArray(bldarg) && bldarg.every((item) => typeof item === "string") ? [...bldarg] : undefined;
}

export function scrubInternalEnvBldopt(bldopt: string[] | undefined): string[] | undefined {
  if (!bldopt) return bldopt;
  return bldopt.map((entry) =>
    /^--env=(SCVS_[A-Z0-9_]+)=.+$/.test(entry) ? entry.replace(/^--env=(SCVS_[A-Z0-9_]+)=.+$/, "--env=$1=<redacted>") : entry,
  );
}

const BLDOPT_SHORT_FLAG_LONG_FORM: Record<string, string> = { "-p": "--package" };

const BLDOPT_LONG_FLAGS_TAKING_A_VALUE = new Set([
  "--manifest-path",
  "--package",
  "--meta",
  "--features",
  "--profile",
]);

function normaliseBldopt(bldopt: string[] | undefined): string[] | undefined {
  if (!bldopt) return bldopt;
  const normalised: string[] = [];
  for (let index = 0; index < bldopt.length; index += 1) {
    const token = bldopt[index];
    const longForm = BLDOPT_SHORT_FLAG_LONG_FORM[token];
    const flag = longForm ?? token;
    const value = bldopt[index + 1];
    if ((longForm || BLDOPT_LONG_FLAGS_TAKING_A_VALUE.has(flag)) && value !== undefined && !value.startsWith("-")) {
      normalised.push(`${flag}=${value}`);
      index += 1;
      continue;
    }
    normalised.push(token);
  }
  return normalised;
}

function requireResult(job: JobRecord): VerificationResultSummaryDto {
  if (!job.result) {
    throw new Error(`assembleArtifact: job ${job.jobId} has no result summary yet.`);
  }
  return job.result as VerificationResultSummaryDto;
}

function requireSourceSha256(job: JobRecord): string {
  const sourceSha256 = job.sourceRef.source_sha256;
  if (!sourceSha256) {
    throw new Error(`assembleArtifact: job ${job.jobId}'s sourceRef has no source_sha256.`);
  }
  return sourceSha256;
}

function buildRecipeRecord(
  job: JobRecord,
  environment: PublishedBuildEnvironment,
): PublishedBuildRecipe {
  return {
    build_image: environment.buildImage,
    build_environment:
      environment.kind === "composed"
        ? {
            kind: environment.kind,
            trust_level: environment.trustLevel,
            recipe_sha256: environment.recipeSha256,
            image_digest: environment.imageDigest,
            image_reference: environment.buildImage,
            recipe: environment.recipe,
          }
        : {
            kind: environment.kind,
            trust_level: environment.trustLevel,
            image_reference: environment.buildImage,
          },
    ...(job.buildOptions ? { build_options: scrubRecipeBuildOptions(job.buildOptions) } : {}),
  };
}

function scrubRecipeBuildOptions(buildOptions: unknown): Record<string, unknown> {
  const stored = buildOptions as { bldopt?: string[]; [key: string]: unknown };
  if (!Array.isArray(stored?.bldopt)) return stored;
  return { ...stored, bldopt: scrubInternalEnvBldopt(stored.bldopt) };
}

function publishedDiagnostics(diagnostics: SandboxDiagnosticsDto): Omit<SandboxDiagnosticsDto, "command" | "command_summary"> {
  const { command: _command, command_summary: _commandSummary, ...rest } = diagnostics;
  return rest;
}
