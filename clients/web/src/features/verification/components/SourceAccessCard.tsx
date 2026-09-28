import { useRef } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sourceArchiveAccept } from "../constants";
import type {
  SourceAccessMode,
  SourceArchiveInfo,
  VerifyFormValues,
} from "../types";
import { formatBytes } from "../utils/format.util";
import { sourceUriRefusal } from "../utils/evidence-rules.util";

type SourceAccessCardProps = {
  form: UseFormReturn<VerifyFormValues>;
  mode: SourceAccessMode;
  onModeChange: (mode: SourceAccessMode) => void;
  archive: SourceArchiveInfo | null;
  onSelectArchive: (file: File | null) => void;
  archiveError?: string | null;
};

const hintCopy: Record<SourceAccessMode, string> = {
  public_uri:
    "Public link to the exact source archive used for the contract build.",
  upload_archive:
    "Select the exact gzip tarball or zip used for the contract build — the archive is read by its bytes, whatever it is named. Its SHA-256 is recorded in the submission.",
};

export const SourceAccessCard = ({
  form,
  mode,
  onModeChange,
  archive,
  onSelectArchive,
  archiveError = null,
}: SourceAccessCardProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // react-hook-form keeps a field's error after its input unmounts, so read it only on this path.
  const sourceUriError =
    mode === "public_uri" ? form.formState.errors.source_uri?.message : undefined;
  const problem = mode === "public_uri" ? sourceUriError : archiveError ?? undefined;

  return (
    <section className="my-6 border-t border-line pt-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-xs font-bold uppercase tracking-[0.03em] text-ink">
            Source access
            <span className="text-danger-mark"> *</span>
          </h3>
          <p className="m-0 mt-1 text-[0.75rem] leading-[1.45] text-ink/[0.66]">
            Use a public URL when the code is already hosted, or upload the archive
            directly. How the verifier gets the bytes and whether they are published
            are two separate choices — the declaration below is the second one.
          </p>
        </div>
      </div>

      <div className="grid items-center gap-2.5 md:grid-cols-[180px_minmax(0,1fr)]">
        <Select
          value={mode}
          onValueChange={(value) => onModeChange(value as SourceAccessMode)}
        >
          <SelectTrigger aria-label="Source access mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="public_uri">Public URI</SelectItem>
            <SelectItem value="upload_archive">Upload archive</SelectItem>
          </SelectContent>
        </Select>

        {mode === "public_uri" ? (
          <Input
            aria-label="Source URI"
            aria-invalid={sourceUriError ? true : undefined}
            placeholder="https://example.com/my-contract-v1.0.0.tar.gz"
            {...form.register("source_uri", {
              validate: (value) => sourceUriRefusal(value) ?? true,
            })}
          />
        ) : (
          <div
            className={[
              "flex h-11 w-full items-center justify-between gap-3 rounded-md border bg-surface pl-3 pr-1.5",
              archiveError ? "border-danger-fg" : "border-line-strong",
            ].join(" ")}
          >
            <span
              className={[
                "min-w-0 truncate text-[0.875rem]",
                archive ? "font-medium text-ink" : "text-ink/45",
              ].join(" ")}
              title={archive?.name}
            >
              {archive
                ? `${archive.name} · ${formatBytes(archive.size)}`
                : "No archive selected"}
            </span>

            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept={sourceArchiveAccept}
              onChange={(event) =>
                onSelectArchive(event.target.files?.[0] ?? null)
              }
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap border-0 bg-transparent px-2 text-[0.8rem] font-bold text-ink underline decoration-ink/25 underline-offset-[3px] transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
            >
              Select archive <span className="text-[0.85rem]">↑</span>
            </button>
          </div>
        )}
      </div>

      <p
        data-testid="source-access-message"
        className={[
          "m-0 mt-2 text-[0.75rem] leading-[1.45]",
          problem ? "font-medium text-danger-fg" : "text-ink/[0.66]",
        ].join(" ")}
      >
        {problem ?? hintCopy[mode]}
      </p>

      {archive && (
        <p className="m-0 mt-2 scroll-x-hidden overflow-x-auto whitespace-nowrap font-mono text-[0.75rem] text-success-fg">
          SHA-256 {archive.sha256}
        </p>
      )}

      <label className="mt-4 flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-ink"
          {...form.register("is_public")}
        />
        <span className="text-[0.8rem] leading-[1.45] text-ink/[0.8]">
          <span className="font-bold text-ink">Publish this source publicly.</span> Leave this
          unchecked and the bytes are used for the rebuild and then deleted — only the SHA-256
          commitment is published, which is a complete verification either way. Checking it lets
          anyone re-run the rebuild against the exact source, which is the stronger claim.
        </span>
      </label>
    </section>
  );
};
