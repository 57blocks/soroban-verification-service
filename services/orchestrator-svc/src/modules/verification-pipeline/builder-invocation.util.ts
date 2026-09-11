import type {
  BatchJobParams as BatchJobParamsDto,
  BuildArchitecture,
  BuildMode,
  MaterialiseJobParams as MaterialiseJobParamsDto,
  SourceReference as SourceReferenceDto,
  VerificationTarget as VerificationTargetDto,
} from "@scvs/core";

/** What `BatchDispatchService.submitBatchJob` needs to submit one rebuild to AWS Batch. */
export type BuilderInvocationParams = {
  /**
   * Dispatch is rebuild-scoped, not job-scoped — this identifies the shared rebuild whose Batch job is being
   * submitted, and keys its staging artifact.
   */
  rebuildId: string;
  /**
   * The *pinning* target only: whichever job triggered this dispatch, so `stellar contract verify` has a
   * concrete `--wasm-hash` to fetch and rebuild against.
   */
  target: VerificationTargetDto;
  sourceRef: SourceReferenceDto;
  imageDigest: string;
  /**
   * Never reaches `services/builder`: it is dispatch-side routing information, consumed by
   * `batch-dispatch.service.ts` to choose the Batch queue and deliberately absent from both container documents
   * below.
   */
  imageArchitecture?: BuildArchitecture;

  /**
   * The oracle the materialiser checks a rebuilt source archive against; absent means "do not rebuild one",
   * which is correct rather than degraded.
   */
  expectedSourceSha256?: string;
  buildArgs?: string[];
  buildOptions?: string[];
  metadataReplay?: string[];
};

/** The two documents one Batch submission injects, one per container of the split builder. */
export function builderContainerParams(
  params: BuilderInvocationParams,
  mode: BuildMode,
  uploadUrl: string,
  artifactUploadUrl: string,
  canonicalSourceUploadUrl?: string
): { materialise: MaterialiseJobParamsDto; runner: BatchJobParamsDto } {
  return {
    materialise: {
      // The builder only uses this for logging/correlation and never touches the database, so a rebuild id is
      // as good as a job id.
      job_id: params.rebuildId,
      source_ref: params.sourceRef,
      mode,
      // Chain-derived and public.
      ...(params.expectedSourceSha256
        ? { expected_source_sha256: params.expectedSourceSha256 }
        : {}),
      // See MaterialiseJobParams.canonical_source_upload_url.
      ...(canonicalSourceUploadUrl
        ? { canonical_source_upload_url: canonicalSourceUploadUrl }
        : {}),
    },
    runner: {
      job_id: params.rebuildId,
      target: params.target,
      source_ref: withoutSourceUri(params.sourceRef),
      image_digest: params.imageDigest,
      ...(params.buildArgs ? { build_args: params.buildArgs } : {}),
      ...(params.buildOptions ? { build_options: params.buildOptions } : {}),
      ...(params.metadataReplay ? { metadata_replay: params.metadataReplay } : {}),
      mode,
      upload_url: uploadUrl,
      artifact_upload_url: artifactUploadUrl,
    },
  };
}

function withoutSourceUri(sourceRef: SourceReferenceDto): SourceReferenceDto {
  const { source_uri: _dropped, ...rest } = sourceRef;
  return rest as SourceReferenceDto;
}
