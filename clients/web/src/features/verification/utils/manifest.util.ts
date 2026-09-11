import { submittedManifestSchema } from "../constants";
import { splitBuildOptions } from "./build-options.util";
import type { SourceAccessMode, SourceUploadResponse, VerifyFormValues } from "../types";

/** What goes on the wire for a Wasm hash. */
export const normalizeWasmHash = (value?: string) => value?.trim().toLowerCase();

export const buildTarget = (values: VerifyFormValues) => ({
  network: values.network,
  contract_id:
    values.targetType === "contract_id" ? values.contractId?.trim() : undefined,
  wasm_hash:
    values.targetType === "wasm_hash" ? normalizeWasmHash(values.wasmHash) : undefined,
});

/** The manifest actually submitted. Empty optional fields are omitted, not sent blank. */
export const buildInlineManifest = (
  values: VerifyFormValues,
  uploadedSource?: SourceUploadResponse,
  sourceAccessMode?: SourceAccessMode,
) => ({
  schema: submittedManifestSchema,
  target: buildTarget(values),
  bldarg: values.bldarg ? splitBuildOptions(values.bldarg) : undefined,
  bldopt: values.bldopt ? splitBuildOptions(values.bldopt) : undefined,
  // Lowercased on the way out, for the same reason `normalizeWasmHash` above exists: the field rule accepts
  // either case, and the publish boundary's `SEP58_HEX_SHA256` does not.
  source_sha256: (
    uploadedSource?.source_sha256 || values.source_sha256?.trim()
  )?.toLowerCase(),
  source_uri:
    sourceAccessMode === "public_uri"
      ? values.source_uri?.trim() || undefined
      : undefined,
  upload_id: uploadedSource?.upload_id,
  // Always sent, never omitted when false: the server reads absence as false too, but sending it makes the
  // submitted manifest say what was declared rather than leaving it to a default.
  is_public: values.is_public === true,
});
