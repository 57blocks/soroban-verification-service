import type {
  BatchJobParams as BatchJobParamsDto,
  BuildArchitecture,
  BuildMode,
  MaterialiseJobParams as MaterialiseJobParamsDto,
  SourceReference as SourceReferenceDto,
  VerificationTarget as VerificationTargetDto,
} from "@scvs/core";

export type BuilderInvocationParams = {
  rebuildId: string;
  target: VerificationTargetDto;
  sourceRef: SourceReferenceDto;
  imageDigest: string;
  /** Dispatch-side routing only; never sent to the builder. */
  imageArchitecture?: BuildArchitecture;

  expectedSourceSha256?: string;
  buildArgs?: string[];
  buildOptions?: string[];
  metadataReplay?: string[];
};

export function builderContainerParams(
  params: BuilderInvocationParams,
  mode: BuildMode,
  uploadUrl: string,
  artifactUploadUrl: string,
  canonicalSourceUploadUrl?: string
): { materialise: MaterialiseJobParamsDto; runner: BatchJobParamsDto } {
  return {
    materialise: {
      job_id: params.rebuildId,
      source_ref: params.sourceRef,
      mode,
      ...(params.expectedSourceSha256
        ? { expected_source_sha256: params.expectedSourceSha256 }
        : {}),
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
