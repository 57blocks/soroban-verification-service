import type { SubmissionState } from "../types";

/** States that carry a published verification result to render. */
export const RESULT_STATES: SubmissionState[] = [
  "verified",
  "mismatch",
  "source_unavailable",
  "build_failed",
  "policy_rejected",
  "not_attempted",
];

/** Index into `flowSteps` that the submission has reached. `3` is past the last step. */
export const flowStepIndex = (state: SubmissionState) => {
  switch (state) {
    case "submitting":
      return 0;
    case "incomplete":
      return 1;
    case "queued":
      return 2;
    case "verified":
    case "mismatch":
    case "source_unavailable":
    case "build_failed":
    case "policy_rejected":
    case "not_attempted":
      return 3;
    case "error":
      return 0;
    default:
      return -1;
  }
};

export const isFailedState = (state: SubmissionState) =>
  state === "error" ||
  state === "mismatch" ||
  state === "source_unavailable" ||
  state === "build_failed" ||
  state === "policy_rejected";
