import { Loader2 } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { DotLatticeLight } from "@/components/ui/dot-lattice";
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
  mode?: VerifyMode;
  initialJobId?: string;
  forceNew?: boolean;
};

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
    targetType,
    selectTargetType,
    submitTarget,
    preflight,
    rejectedOptions,
    terms,
    availableFields,
    sourceArchive,
    submitCompletedManifest,
    rebuildInputs,
  } = useVerificationConsole({ mode, initialJobId, forceNew });

  return (
    <main className="relative min-h-screen bg-surface-alt font-sans leading-normal text-ink antialiased">
      <DotLatticeLight fadeStart={540} fadeEnd={760} />
      <div className="relative z-[1]">
        <SiteNav />

        <form onSubmit={(event) => event.preventDefault()}>
          <div className="mx-auto max-w-console px-8 pb-16 pt-10">
            <ConsoleHero mode={mode} />

            {mode === "job" && (
              <>
                <CurrentJobBar jobId={currentJobId} onCopyLink={copyJobLink} />
                <JobTimingCard timing={jobTiming} />
              </>
            )}

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

                <RebuildCard inputs={rebuildInputs} />

                {RESULT_STATES.includes(submissionState) && jobResult && (
                  <ResultPanel state={submissionState} result={jobResult} />
                )}

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

            <SiteFooter legalLinksInNewTab />
          </div>
        </form>
      </div>
    </main>
  );
};
