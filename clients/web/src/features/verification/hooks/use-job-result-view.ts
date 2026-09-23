import type { ConsoleState, RecentJob, SubmissionState } from "../types";
import { RESULT_STATES } from "../utils/flow.util";
import { readBuildLogToken } from "../utils/build-log-tokens.store";
import { getSandboxDiagnostics } from "../utils/diagnostics.util";
import { rebuildProvenance } from "../utils/rebuild-provenance.util";
import { useBuildLog } from "./use-build-log";
import { useJobTiming } from "./use-job-timing";
import { usePublishedArtifact } from "./use-published-artifact";

/**
 * Everything the result area shows about one job, derived from what the console already holds.
 *
 * Out of `useVerificationConsole` because none of it writes: it reads the console's state and the recent-jobs
 * list, and asks three read-only hooks. The state machine that produces that state stays where it is.
 */
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
  /**
   * The job reached an outcome. Narrower than the console's `hasResult`, which is "the console has something to
   * show" and includes `queued`.
   */
  const hasJobOutcome = RESULT_STATES.includes(submissionState);

  /** UI2: the log is fetched for every terminal outcome, not only failures. */
  const buildLog = useBuildLog(currentJobId ?? null, hasJobOutcome);

  // Timestamps live on the job arm only — a submit response has never carried them.
  const jobRecord = consoleState.phase === "job" ? consoleState.response : undefined;
  // The instant this job settled, frozen when this browser first saw it settle.
  const jobFinishedAt = currentJobId
    ? recentJobs.find((job) => job.job_id === currentJobId)?.finished_at
    : undefined;
  // The published document's instant — outranked by `completed_at`; see `useJobTiming`.
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

  // A `result` reaches the console over the job stream and nowhere else — a submit response has never carried
  // one.
  const jobResult = consoleState.phase === "job" ? consoleState.response.result : undefined;

  // The job record is authoritative about exactly one thing here, where its own artifact was written, and it
  // carries the hash to check it against.
  const publishedArtifact = usePublishedArtifact(
    typeof jobResult?.artifact_url === "string" ? jobResult.artifact_url : undefined,
    typeof jobResult?.artifact_sha256 === "string" ? jobResult.artifact_sha256 : undefined,
  );

  // Resolved here, not in the card: components render, hooks decide (AGENTS.md).
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
    /** When this job was accepted and how long it has taken. `null` until a job record arrives. */
    jobTiming,
    buildLog,
    // Only ever the token this browser already holds — nothing here asks the API for one.
    buildLogToken: readBuildLogToken(currentJobId ?? null),
    /** The published result to render, when there is one. Job stream only. */
    jobResult,
    publishedArtifact,
    /** `RebuildCard`'s groups, in reading order. Empty until the report has been read. */
    provenanceGroups,
  };
};
