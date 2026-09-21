import { Loader2 } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { useVerificationConsole } from "../hooks/use-verification-console";
import type { VerifyMode } from "../types";
import { RESULT_STATES } from "../utils/flow.util";
import { ConsoleHero } from "./ConsoleHero";
import { CurrentJobBar } from "./CurrentJobBar";
import { EvidenceCard } from "./EvidenceCard";
import { FlowProgress } from "./FlowProgress";
import { JobTimingCard } from "./JobTimingCard";
import { BuildLogPanel } from "./BuildLogPanel";
import { PreflightCard } from "./PreflightCard";
import { SourceVisibilityRow } from "./SourceVisibilityRow";
import { RecentJobsCard } from "./RecentJobsCard";
import { ResultPanel } from "./ResultPanel";
import { StatusBanner } from "./StatusBanner";
import { TargetCard } from "./TargetCard";
import { RebuildCard } from "./RebuildCard";

const ConsoleLoading = ({ mode }: { mode: VerifyMode }) => (
  <div className="mt-8 flex items-center gap-3 rounded-xl border border-line bg-surface p-5 shadow-panel">
    <Loader2 aria-hidden className="size-4 animate-spin text-ink" />
    <span className="text-[0.875rem] font-medium text-ink-value">
      {mode === "job"
        ? "Loading verification job..."
        : "Checking chain metadata..."}
    </span>
  </div>
);

export type VerifyConsoleProps = {
  /** `submit` starts a new verification; `job` opens an existing one. */
  mode?: VerifyMode;
  initialJobId?: string;
  /** Set by `/verify?new=1` to clear a finished submission and start over. */
  forceNew?: boolean;
};

/**
 * The verify console. One react-hook-form instance spans the whole page: the target card and the evidence card
 * are two stages of the same submission, so they share it.
 */
export const VerifyConsole = ({
  mode = "submit",
  initialJobId,
  forceNew = false,
}: VerifyConsoleProps) => {
  const {
    form,
    values,
    recentJobs,
    submissionState,
    banner,
    jobResult,
    responseMeta,
    isSubmitting,
    hasResult,
    showSubmitForm,
    showEvidenceForm,
    currentStep,
    isFailed,
    currentJobId,
    jobTiming,
    copyJobLink,
    buildLog,
    buildLogToken,
    publishedArtifact,
    targetType,
    selectTargetType,
    submitTarget,
    preflight,
    rejectedOptions,
    terms,
    availableFields,
    sourceArchive,
    submitCompletedManifest,
    provenanceGroups,
  } = useVerificationConsole({ mode, initialJobId, forceNew });

  return (
    <main className="relative min-h-screen bg-surface-alt font-sans leading-normal text-ink antialiased">
      <div className="relative z-[1]">
        <SiteNav />

        {/* Submission is driven by explicit buttons, not a native submit — the page holds two
          stages of one request and each has its own handler. */}
        <form onSubmit={(event) => event.preventDefault()}>
          <div className="mx-auto max-w-console px-8 pb-16 pt-10">
            <ConsoleHero mode={mode} />

            {mode === "job" && (
              <>
                <CurrentJobBar jobId={currentJobId} onCopyLink={copyJobLink} />
                <JobTimingCard timing={jobTiming} />
              </>
            )}

            {/* Only once there is a job to track. Before that the strip reported the first step of a form
                the reader can already see, which is what put it between them and the field.
                `allComplete` had one producer, `already_verified`, which submit could never send.
                `verified` is the state that actually completes the flow. */}
            {submissionState !== "idle" && (
              <FlowProgress
                currentStep={currentStep}
                isFailed={isFailed}
                allComplete={submissionState === "verified"}
              />
            )}

            {showSubmitForm && (
              <TargetCard
                form={form}
                targetType={targetType}
                onTargetTypeChange={selectTargetType}
                isSubmitting={isSubmitting}
                onSubmit={submitTarget}
              />
            )}

            <PreflightCard state={preflight} />

            {submissionState === "submitting" && <ConsoleLoading mode={mode} />}

            {showEvidenceForm && !hasResult && (
              <div className="mt-8">
                <EvidenceCard
                  form={form}
                  availableFields={availableFields}
                  sourceAccess={{
                    mode: sourceArchive.mode,
                    onModeChange: sourceArchive.selectMode,
                    archive: sourceArchive.archive,
                    onSelectArchive: sourceArchive.onSelectArchive,
                    error: sourceArchive.error,
                  }}
                  isSubmitting={isSubmitting}
                  onSubmit={submitCompletedManifest}
                  rejectedOptions={rejectedOptions}
                  terms={terms}
                />
              </div>
            )}

            {hasResult && (
              <div className="mt-8 space-y-6">
                {responseMeta && (
                  <StatusBanner
                    state={submissionState}
                    meta={responseMeta}
                    view={banner}
                    fallbackNetwork={values.network}
                    showJobId={mode !== "job"}
                  />
                )}

                {/* Verdict, then how it was rebuilt, then what that produced. */}
                <RebuildCard groups={provenanceGroups} />

                {RESULT_STATES.includes(submissionState) && jobResult && (
                  <ResultPanel state={submissionState} result={jobResult} />
                )}

                <SourceVisibilityRow state={publishedArtifact} />

                <BuildLogPanel state={buildLog} token={buildLogToken} />

                {showEvidenceForm && (
                  <EvidenceCard
                    form={form}
                    availableFields={availableFields}
                    sourceAccess={{
                      mode: sourceArchive.mode,
                      onModeChange: sourceArchive.selectMode,
                      archive: sourceArchive.archive,
                      onSelectArchive: sourceArchive.onSelectArchive,
                      error: sourceArchive.error,
                    }}
                    isSubmitting={isSubmitting}
                    onSubmit={submitCompletedManifest}
                    rejectedOptions={rejectedOptions}
                    terms={terms}
                  />
                )}
              </div>
            )}

            {mode === "submit" && <RecentJobsCard jobs={recentJobs} />}

            {/* New tab, not an in-place route change: this page's whole submission — the
                preflight answer, the prefilled evidence, the archive hashed in this browser — is
                component state, and a navigation away loses it. Same reason as
                `SubmissionAgreement`. */}
            <SiteFooter legalLinksInNewTab />
          </div>
        </form>
      </div>
    </main>
  );
};
