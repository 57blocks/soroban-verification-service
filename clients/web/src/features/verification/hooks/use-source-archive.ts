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
  archiveFormatRefusal,
  chainSourceRefusal,
  readArchiveHead,
} from "../utils/source-archive.util";

export const useSourceArchive = (
  form: UseFormReturn<VerifyFormValues>,
  chainSourceSha256?: string,
) => {
  const [mode, setMode] = useState<SourceAccessMode>("public_uri");
  const [archive, setArchive] = useState<SourceArchiveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadSourceMutation = useUploadSource();

  const refuse = (message: string, options?: { duration?: number }) => {
    setArchive(null);
    setError(message);
    if (options) toast.error(message, options);
    else toast.error(message);
  };

  const selectMode = (nextMode: SourceAccessMode) => {
    setMode(nextMode);
    setError(null);
    if (nextMode === "upload_archive") {
      form.clearErrors("source_uri");
      form.setValue("source_uri", "");
    }
  };

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

    try {
      // `accept` only filters the picker, so the format is decided here from the file's head.
      const formatRefusal = archiveFormatRefusal(await readArchiveHead(file));
      if (formatRefusal) {
        refuse(formatRefusal);
        return;
      }

      const sha256 = await fileToSha256(file);

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
      console.error("Source archive could not be read", cause);
      refuse(
        cause instanceof Error
          ? `Could not read the source archive: ${cause.message}`
          : "Could not read the source archive",
      );
    }
  };

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
      throw new Error(errorMessage(cause, "Source archive upload failed."), { cause });
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

  const reset = useCallback(() => {
    setArchive(null);
    setError(null);
    setMode("public_uri");
  }, []);

  return {
    mode,
    selectMode,
    archive,
    error,
    onSelectArchive,
    requireArchive,
    upload,
    reset,
  };
};
