import { useCallback, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { useUploadSource } from "@scvs/verify-api-client";
import { errorMessage } from "@/lib/http";
import type {
  SourceAccessMode,
  SourceArchiveInfo,
  SourceUploadResponse,
  VerifyFormValues,
} from "../types";
import { fileToSha256 } from "../utils/format.util";
import {
  acceptedSourceArchiveSuffixes,
  chainSourceRefusal,
  isAcceptedSourceArchiveName,
} from "../utils/source-archive.util";

/** How the verifier will get the source bytes. Either a public URI it fetches itself, or an archive picked here. */
export const useSourceArchive = (
  form: UseFormReturn<VerifyFormValues>,
  /** What preflight read off the chain, when it read one. */
  chainSourceSha256?: string,
) => {
  const [mode, setMode] = useState<SourceAccessMode>("public_uri");
  const [archive, setArchive] = useState<SourceArchiveInfo | null>(null);
  /** Why the picked archive is not an answer — rendered next to the picker by `SourceAccessCard`. */
  const [error, setError] = useState<string | null>(null);
  const uploadSourceMutation = useUploadSource();

  /** Every refusal path, so a rejected pick reads the same in the toast and beside the control. */
  const refuse = (message: string, options?: { duration?: number }) => {
    setArchive(null);
    setError(message);
    // Called without the second argument when there is none, rather than with `undefined`: the chain-hash
    // refusal is the only one that wants a longer dwell, and every other caller should keep sonner's own
    // default rather than pass a placeholder.
    if (options) toast.error(message, options);
    else toast.error(message);
  };

  const selectMode = (nextMode: SourceAccessMode) => {
    setMode(nextMode);
    // The refusal belonged to the mode being left.
    setError(null);
    if (nextMode === "upload_archive") {
      form.clearErrors("source_uri");
      // Only the URI is cleared.
      form.setValue("source_uri", "");
    }
  };

  /** The upload path's own required-field check, run before a submission is sent rather than after. */
  const requireArchive = (): string | null => {
    if (archive) return null;
    const message = "Select the exact source archive to upload.";
    setError(message);
    return message;
  };

  const onSelectArchive = async (file: File | null) => {
    if (!file) {
      setArchive(null);
      setError(null);
      return;
    }

    // The `accept` attribute only filters the picker — "All Files" defeats it — so the same rule is applied to
    // what came back.
    if (!isAcceptedSourceArchiveName(file.name)) {
      refuse(
        `Only a gzip-compressed tarball or a zip is accepted (${acceptedSourceArchiveSuffixes.join(", ")}).`,
      );
      return;
    }

    try {
      const sha256 = await fileToSha256(file);

      // Refusing at the picker rather than at submit keeps the reason next to the control that caused it,
      // exactly as the suffix refusal above does, and costs no upload.
      const refusal = chainSourceRefusal(chainSourceSha256, sha256);
      if (refusal) {
        form.setValue("source_sha256", "", { shouldValidate: true });
        refuse(refusal, { duration: 30_000 });
        return;
      }

      setArchive({ name: file.name, size: file.size, sha256, file });
      setError(null);
      form.setValue("source_sha256", sha256, { shouldValidate: true });
      toast.success("Source archive SHA-256 calculated");
    } catch (cause) {
      // Swallowing this made every cause look identical: a missing SubtleCrypto, a file the browser can no
      // longer read, a permission prompt the user dismissed.
      console.error("Source archive SHA-256 failed", cause);
      refuse(
        cause instanceof Error
          ? `Could not calculate source archive hash: ${cause.message}`
          : "Could not calculate source archive hash",
      );
    }
  };

  /**
   * Uploads the picked archive to the staging bucket. Throws with a user-facing message — the caller surfaces
   * it as the submission's error state.
   */
  const upload = async (
    declaredSha256?: string,
  ): Promise<SourceUploadResponse> => {
    const file = archive?.file;
    if (!file) {
      throw new Error(
        "Select a source archive before submitting an upload.",
      );
    }

    let data: SourceUploadResponse;
    try {
      const res = await uploadSourceMutation.mutateAsync({ data: file });
      data = res.data;
    } catch (cause) {
      throw new Error(errorMessage(cause, "Source archive upload failed."));
    }

    if (!data.upload_id || !data.source_sha256) {
      throw new Error("Source archive upload failed.");
    }
    if (
      declaredSha256 &&
      data.source_sha256.toLowerCase() !== declaredSha256.toLowerCase()
    ) {
      throw new Error(
        "Uploaded archive SHA-256 changed before submit. Select the archive again.",
      );
    }
    return data;
  };

  // Stable identity: the console clears this from an effect keyed on the target, and an unstable callback there
  // would re-run it on every render.
  const reset = useCallback(() => {
    setArchive(null);
    setError(null);
    // The mode was chosen for the target being left; a new one starts at the default again.
    setMode("public_uri");
  }, []);

  return {
    mode,
    selectMode,
    archive,
    /** The picker's own refusal, for rendering beside it. `null` when there is nothing to say. */
    error,
    onSelectArchive,
    requireArchive,
    upload,
    reset,
  };
};
