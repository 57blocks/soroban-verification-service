/** Submitting, and waiting. */
import { buildLogTokenFor } from "./build-log-token.js";
import { env } from "./env.js";
import { expectStatus, http, postJson, sleep, type HttpResult } from "./http.js";
import { jobLogUrl, jobUrl, submitUrl, preflightUrl, uploadSourceUrl } from "./routes.js";
import {
  TERMINAL_JOB_STATUSES,
  type JobStatusBody,
  type SubmitBody,
  type SubmitQueued,
  type UploadSourceResponse,
} from "./types.js";

export interface SubmissionOutcome {
  readonly response: HttpResult;
  /** Present only on a 202. */
  readonly jobId?: string;
}

export async function preflight(body: {
  network: string;
  contract_id?: string;
  wasm_hash?: string;
}): Promise<HttpResult> {
  return postJson(preflightUrl(), body);
}

export async function submit(body: SubmitBody): Promise<SubmissionOutcome> {
  const response = await postJson(submitUrl(), body);
  const jobId =
    response.status === 202 && typeof response.json?.job_id === "string"
      ? (response.json as SubmitQueued).job_id
      : undefined;
  return { response, jobId };
}

/** Submits and asserts the 202, for the many cases where a rejection is simply not the subject. */
export async function submitAccepted(
  body: SubmitBody,
  options: { requireFreshTargetJob?: boolean } = {},
): Promise<{ jobId: string; at: number; response: HttpResult }> {
  const at = Date.now();
  const outcome = await submit(body);
  expectStatus(outcome.response, 202);
  if (!outcome.jobId) {
    throw new Error(`202 from ${submitUrl()} carried no job_id. Body: ${outcome.response.text}`);
  }
  if (
    options.requireFreshTargetJob &&
    /already queued or running/i.test(String(outcome.response.json?.message ?? ""))
  ) {
    throw new Error(
      `Submission reused active job ${outcome.jobId} for its target instead of creating this case's own job. ` +
        "Use an isolated target fixture or wait for the earlier job to become terminal.",
    );
  }
  return { jobId: outcome.jobId, at, response: outcome.response };
}

export async function readJob(jobId: string): Promise<JobStatusBody> {
  const result = await http(jobUrl(jobId));
  expectStatus(result, 200);
  return result.json as JobStatusBody;
}

export interface TerminalJob {
  readonly body: JobStatusBody;
  /** `queued` → terminal, in milliseconds. The DEDUP criterion's T1/T2. */
  readonly wallClockMs: number;
  /** Every distinct status observed, in order — `E2E-SUB-14` compares this against the SSE stream. */
  readonly statusSequence: string[];
  /** Every distinct `progress.step` observed, in order. */
  readonly progressSteps: string[];
}

/**
 * `build_failed` is the only published status a job can leave again: `requeueRetryableFailures` scans
 * internal `failed` rows whose reason is `build_timeout` or `internal_error`, and both publish as
 * `build_failed`. The published body never says which reason it was, so outlasting one scan is the only way
 * to tell a final failure from one about to be retried — which is why this is a caller's choice. A case
 * asserting *that* a build failed wants the first terminal state; a case that needs the job's final answer
 * passes `settleMs`.
 */
const REQUEUEABLE_STATUS = "build_failed";

/** One `SCVS_JOB_RETRY_INTERVAL_MS` scan plus a poll, so a re-queue that is going to happen has happened. */
export const RETRYABLE_SETTLE_MS = Number(process.env.SCVS_JOB_RETRY_INTERVAL_MS || 60_000) + 2_000;

export async function waitForTerminal(
  jobId: string,
  options: { timeoutMs?: number; startedAt?: number; settleMs?: number } = {}
): Promise<TerminalJob> {
  const timeoutMs = options.timeoutMs ?? env.jobTimeoutMs;
  const settleMs = options.settleMs ?? 0;
  const startedAt = options.startedAt ?? Date.now();
  const deadline = startedAt + timeoutMs;
  const statusSequence: string[] = [];
  const progressSteps: string[] = [];
  let last: JobStatusBody | undefined;
  // When the status now being held was first seen. T1/T2 measure to that instant, not to `Date.now()`, so
  // settling does not inflate the wall clock a caller reads.
  let heldSince = 0;

  while (Date.now() < deadline) {
    const previous = last?.status;
    last = await readJob(jobId);
    if (last.status !== previous) {
      statusSequence.push(last.status);
      heldSince = Date.now();
    }
    const step = last.progress?.step;
    if (step && progressSteps[progressSteps.length - 1] !== step) {
      progressSteps.push(step);
    }
    if (TERMINAL_JOB_STATUSES.includes(last.status)) {
      const mayStillBeRequeued = settleMs > 0 && last.status === REQUEUEABLE_STATUS;
      if (!mayStillBeRequeued || Date.now() - heldSince >= settleMs) {
        return { body: last, wallClockMs: heldSince - startedAt, statusSequence, progressSteps };
      }
    }
    await sleep(env.pollIntervalMs);
  }

  // A `build_failed` still inside its settle window when the job timeout expired did reach a terminal state.
  // Reporting "never reached one" would be false.
  if (last && TERMINAL_JOB_STATUSES.includes(last.status)) {
    return { body: last, wallClockMs: heldSince - startedAt, statusSequence, progressSteps };
  }

  throw new Error(
    `Job ${jobId} never reached a terminal state within ${timeoutMs} ms. ` +
      `Statuses seen: ${statusSequence.join(" → ") || "(none)"}. ` +
      // A job that timed out while composing looks identical to one stuck in `preparing` unless the progress
      // line is printed too, and "which of those was it" is the first question asked.
      `Progress steps seen: ${progressSteps.join(" → ") || "(none)"}. ` +
      `Last body: ${JSON.stringify(last)}`
  );
}

export async function submitAndWait(
  body: SubmitBody,
  options: { timeoutMs?: number; requireFreshTargetJob?: boolean; settleMs?: number } = {}
): Promise<TerminalJob & { jobId: string }> {
  const { jobId, at } = await submitAccepted(body, options);
  const terminal = await waitForTerminal(jobId, { ...options, startedAt: at });
  return { ...terminal, jobId };
}

/**
 * `GET …/log` returns `text/plain`, and a JSON envelope on every other arm of BL-1's ladder: 401 with no
 * `X-Build-Log-Token`, 404 with a wrong one *and* when the job recorded no log — the two are deliberately
 * indistinguishable, so the route is not an oracle for which job ids exist — and 410 once the log expires.
 *
 * The token is attached from this run's own submissions. A job this run did not create has none, and the
 * resulting 401 is the correct answer rather than a harness defect: its log belongs to the submission that
 * created it.
 */
export async function readJobLog(jobId: string): Promise<HttpResult> {
  const token = buildLogTokenFor(jobId);
  return http(jobLogUrl(jobId), {
    headers: { accept: "text/plain", ...(token ? { "x-build-log-token": token } : {}) },
  });
}

/** Uploads raw archive bytes. */
export async function uploadSource(
  bytes: Uint8Array,
  filename = "source.tar.gz"
): Promise<UploadSourceResponse> {
  // The upload door decides archive format from magic bytes. Keep the conventional MIME type on the wire too,
  // so ZIP E2E rows exercise the same browser request shape rather than a gzip-labelled ZIP.
  const contentType = filename.toLowerCase().endsWith(".zip") ? "application/zip" : "application/gzip";
  const result = await http(uploadSourceUrl(), {
    method: "POST",
    headers: { "content-type": contentType, "x-filename": filename },
    body: bytes,
  });
  expectStatus(result, 201);
  return result.json as UploadSourceResponse;
}

/**
 * `JobsRepository.requeueRetryableFailures` sets `progress_step = "queued"` together with this string, and
 * `progress` is a published field on `GET /v1/verifications/:job_id`.
 */
export const RULE_D_REQUEUE_DETAIL = "Retrying after a retryable failure.";

export interface RequeueWatch {
  /** The last body observed — where the job stood when the window closed. */
  readonly body: JobStatusBody;
  readonly statusSequence: string[];
  readonly progressSteps: string[];
  readonly progressDetails: string[];
  /** Every distinct `updated_at` observed, in order. */
  readonly updatedAtSequence: string[];
  /** Terminal → non-terminal transitions actually observed. */
  readonly requeues: number;
  readonly sawRequeueMarker: boolean;
  readonly endedTerminal: boolean;
  readonly watchedMs: number;
  /** Human-readable, attached verbatim to an assertion message. */
  readonly explanation: string;
}

/** Keeps polling a job **past** its first terminal state. */
export async function watchPastTerminal(
  jobId: string,
  options: { windowMs: number; stopOnFirstRequeue?: boolean }
): Promise<RequeueWatch> {
  const startedAt = Date.now();
  const deadline = startedAt + options.windowMs;
  const statusSequence: string[] = [];
  const progressSteps: string[] = [];
  const progressDetails: string[] = [];
  const updatedAtSequence: string[] = [];
  let requeues = 0;
  let sawRequeueMarker = false;
  let previousWasTerminal: boolean | undefined;
  let body: JobStatusBody;

  for (;;) {
    body = await readJob(jobId);
    const terminal = TERMINAL_JOB_STATUSES.includes(body.status);

    if (statusSequence[statusSequence.length - 1] !== body.status) statusSequence.push(body.status);
    if (updatedAtSequence[updatedAtSequence.length - 1] !== body.updated_at) {
      updatedAtSequence.push(body.updated_at);
    }
    const step = body.progress?.step;
    if (step && progressSteps[progressSteps.length - 1] !== step) progressSteps.push(step);
    const detail = body.progress?.detail;
    if (detail && progressDetails[progressDetails.length - 1] !== detail) progressDetails.push(detail);
    if (detail === RULE_D_REQUEUE_DETAIL) sawRequeueMarker = true;

    // A job that left a terminal status was re-queued by something.
    if (previousWasTerminal === true && !terminal) requeues += 1;
    previousWasTerminal = terminal;

    if (options.stopOnFirstRequeue && requeues > 0) break;
    if (Date.now() + env.pollIntervalMs >= deadline) break;
    await sleep(env.pollIntervalMs);
  }

  const watchedMs = Date.now() - startedAt;
  const explanation = [
    `watched ${jobId} for ${watchedMs} ms (window ${options.windowMs} ms, poll ${env.pollIntervalMs} ms)`,
    `statuses: ${statusSequence.join(" → ") || "(none)"}`,
    `progress steps: ${progressSteps.join(" → ") || "(none)"}`,
    `progress details: ${progressDetails.map((d) => JSON.stringify(d)).join(" → ") || "(none)"}`,
    `updated_at values: ${updatedAtSequence.join(" → ") || "(none)"}`,
    `observed re-queues: ${requeues}; Rule D marker seen: ${sawRequeueMarker}`,
    `last body: ${JSON.stringify(body!)}`,
  ].join("\n  · ");

  return {
    body: body!,
    statusSequence,
    progressSteps,
    progressDetails,
    updatedAtSequence,
    requeues,
    sawRequeueMarker,
    endedTerminal: TERMINAL_JOB_STATUSES.includes(body!.status),
    watchedMs,
    explanation,
  };
}
