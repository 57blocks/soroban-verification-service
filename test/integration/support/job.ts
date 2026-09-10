/** Submitting, and waiting. */
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

export async function waitForTerminal(
  jobId: string,
  options: { timeoutMs?: number; startedAt?: number } = {}
): Promise<TerminalJob> {
  const timeoutMs = options.timeoutMs ?? env.jobTimeoutMs;
  const startedAt = options.startedAt ?? Date.now();
  const deadline = startedAt + timeoutMs;
  const statusSequence: string[] = [];
  const progressSteps: string[] = [];
  let last: JobStatusBody | undefined;

  while (Date.now() < deadline) {
    last = await readJob(jobId);
    if (statusSequence[statusSequence.length - 1] !== last.status) {
      statusSequence.push(last.status);
    }
    const step = last.progress?.step;
    if (step && progressSteps[progressSteps.length - 1] !== step) {
      progressSteps.push(step);
    }
    if (TERMINAL_JOB_STATUSES.includes(last.status)) {
      return { body: last, wallClockMs: Date.now() - startedAt, statusSequence, progressSteps };
    }
    await sleep(env.pollIntervalMs);
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
  options: { timeoutMs?: number; requireFreshTargetJob?: boolean } = {}
): Promise<TerminalJob & { jobId: string }> {
  const { jobId, at } = await submitAccepted(body, options);
  const terminal = await waitForTerminal(jobId, { ...options, startedAt: at });
  return { ...terminal, jobId };
}

/** `GET …/log` returns `text/plain`, and 404s with a JSON envelope when the job recorded none. */
export async function readJobLog(jobId: string): Promise<HttpResult> {
  return http(jobLogUrl(jobId), { headers: { accept: "text/plain" } });
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
