import type { ConsoleState, RecentJob, SubmissionState } from "../types";
import { RESULT_STATES } from "../utils/flow.util";
import { readBuildLogToken } from "../utils/build-log-tokens.store";
import { getSandboxDiagnostics } from "../utils/diagnostics.util";
import { rebuildProvenance } from "../utils/rebuild-provenance.util";
import { useBuildLog } from "./use-build-log";
import { useJobTiming } from "./use-job-timing";
import { usePublishedArtifact } from "./use-published-artifact";

export const useJobResultView = ({
  consoleState,
  submissionState,
  currentJobId,
  recentJobs,
}: {
  consoleState: ConsoleState;
  submissionState: SubmissionState;
  currentJobId: string | undefined;
  recentJobs: RecentJob[];
}) => {
  const hasJobOutcome = RESULT_STATES.includes(submissionState);

  const buildLog = useBuildLog(currentJobId ?? null, hasJobOutcome);

  const jobRecord = consoleState.phase === "job" ? consoleState.response : undefined;
  const jobFinishedAt = currentJobId
    ? recentJobs.find((job) => job.job_id === currentJobId)?.finished_at
    : undefined;
  const jobVerifiedAt =
    consoleState.phase === "job" && typeof consoleState.response.result?.verified_at === "string"
      ? consoleState.response.result.verified_at
      : undefined;
  const jobTiming = useJobTiming(
    jobRecord?.created_at,
    jobRecord?.updated_at,
    consoleState.phase === "job" && !hasJobOutcome && submissionState !== "error",
    jobFinishedAt,
    jobVerifiedAt,
    jobRecord?.completed_at,
  );

  const jobResult = consoleState.phase === "job" ? consoleState.response.result : undefined;

  const publishedArtifact = usePublishedArtifact(
    typeof jobResult?.artifact_url === "string" ? jobResult.artifact_url : undefined,
    typeof jobResult?.artifact_sha256 === "string" ? jobResult.artifact_sha256 : undefined,
  );

  const jobDiagnostics = getSandboxDiagnostics(jobResult);
  const publishedRecipe =
    publishedArtifact.phase === "published" ? publishedArtifact.recipe : undefined;
  const provenanceGroups = publishedRecipe
    ? rebuildProvenance({
        recipe: publishedRecipe,
        sourceUri: publishedArtifact.phase === "published" ? publishedArtifact.source.sourceUri : null,
        sourceSha256:
          publishedArtifact.phase === "published" ? publishedArtifact.source.sourceSha256 : null,
        diagnostics: jobDiagnostics,
      })
    : [];

  return {
    jobTiming,
    buildLog,
    buildLogToken: readBuildLogToken(currentJobId ?? null),
    jobResult,
    publishedArtifact,
    provenanceGroups,
  };
};
