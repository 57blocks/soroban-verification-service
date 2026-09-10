import type { UseFormReturn } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import type {
  RejectedBuildOption,
  SourceAccessMode,
  SourceArchiveInfo,
  VerifyFormValues,
} from "../types";
import { EvidenceFields } from "./EvidenceFields";
import { RejectedOptions } from "./RejectedOptions";
import { EvidenceMetadata } from "./EvidenceMetadata";
import { SourceAccessCard } from "./SourceAccessCard";
import { SubmissionAgreement } from "./SubmissionAgreement";

type EvidenceCardProps = {
  form: UseFormReturn<VerifyFormValues>;
  availableFields: Record<string, unknown>;
  sourceAccess: {
    mode: SourceAccessMode;
    onModeChange: (mode: SourceAccessMode) => void;
    archive: SourceArchiveInfo | null;
    onSelectArchive: (file: File | null) => void;
    /** The picker's own refusal, rendered beside it rather than only as a toast. */
    error?: string | null;
  };
  isSubmitting: boolean;
  onSubmit: () => void;
  /** Build options this verifier will not replay — UI1a, labelled `policy_rejected`. */
  rejectedOptions: RejectedBuildOption[];
  /** The clickwrap state — this card holds the only control that forms an agreement (design.md TA-1). */
  terms: {
    accepted: boolean;
    onAcceptedChange: (accepted: boolean) => void;
    disabledReason?: string;
  };
  /** False while the terms gate refuses; the button says why rather than failing on press. */
  canSubmit: boolean;
};

/** Stage two: the source and build evidence the chain did not already state. */
export const EvidenceCard = ({
  form,
  availableFields,
  sourceAccess,
  isSubmitting,
  onSubmit,
  rejectedOptions,
  terms,
  canSubmit,
}: EvidenceCardProps) => (
  <section className="overflow-hidden rounded-lg bg-surface shadow-panel">
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 className="m-0 font-display text-[1.35rem] font-semibold text-ink">
          Complete missing evidence
        </h2>
      </div>

      <p className="m-0 mb-5 text-[0.875rem] leading-[1.5] text-ink/[0.66]">
        Add only what the verifier needs. Fill in the fields below, then submit
        the completed manifest.
      </p>

      <EvidenceMetadata availableFields={availableFields} />

      <EvidenceFields form={form} />

      <SourceAccessCard
        form={form}
        mode={sourceAccess.mode}
        onModeChange={sourceAccess.onModeChange}
        archive={sourceAccess.archive}
        onSelectArchive={sourceAccess.onSelectArchive}
        archiveError={sourceAccess.error}
      />

      {/* This button is the submission — the public declaration made above becomes permanent
          here — so the agreement is restated beside it, not only at the preflight step. */}
      <div className="flex flex-wrap items-end justify-end gap-x-6 gap-y-2">
        <RejectedOptions rejected={rejectedOptions} />
        <SubmissionAgreement className="mt-0 max-w-[36ch] text-left" acceptance={terms} />
        <Button
          onClick={onSubmit}
          disabled={isSubmitting || !canSubmit}
          aria-busy={isSubmitting}
          title={canSubmit ? undefined : "Accept the Terms of Service to submit"}
        >
          Submit completed manifest
          <PillIcon animated={!isSubmitting}>
            {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : "→"}
          </PillIcon>
        </Button>
      </div>
    </div>
  </section>
);
