import { submittedManifestSchema } from "../constants";
import { splitBuildOptions } from "./build-options.util";
import type { SourceAccessMode, SourceUploadResponse, VerifyFormValues } from "../types";

export const normalizeWasmHash = (value?: string) => value?.trim().toLowerCase();

export const buildTarget = (values: VerifyFormValues) => ({
  network: values.network,
  contract_id:
    values.targetType === "contract_id" ? values.contractId?.trim() : undefined,
  wasm_hash:
    values.targetType === "wasm_hash" ? normalizeWasmHash(values.wasmHash) : undefined,
});

export const buildInlineManifest = (
  values: VerifyFormValues,
  uploadedSource?: SourceUploadResponse,
  sourceAccessMode?: SourceAccessMode,
) => ({
  schema: submittedManifestSchema,
  target: buildTarget(values),
  bldarg: values.bldarg ? splitBuildOptions(values.bldarg) : undefined,
  bldopt: values.bldopt ? splitBuildOptions(values.bldopt) : undefined,
  // Lowercased: the field rule accepts either case, the publish boundary lowercase only.
  source_sha256: (
    uploadedSource?.source_sha256 || values.source_sha256?.trim()
  )?.toLowerCase(),
  source_uri:
    sourceAccessMode === "public_uri"
      ? values.source_uri?.trim() || undefined
      : undefined,
  upload_id: uploadedSource?.upload_id,
  is_public: values.is_public === true,
});
