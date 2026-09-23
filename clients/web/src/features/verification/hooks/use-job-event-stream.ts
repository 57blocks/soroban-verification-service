import { useEffect, useRef } from "react";
import { jobEventsPath } from "@scvs/verify-api-client";
import { getApiBase } from "@/lib/http";
import type { JobResponse, TerminalSubmissionState } from "../types";

type JobStreamHandlers = {
  /** A non-terminal update — still `queued` or `running`. `detail` is the best progress line. */
  onProgress: (data: JobResponse, detail?: string) => void;
  onTerminal: (state: TerminalSubmissionState, data: JobResponse) => void;
  /** The connection is gone for good (bad job id, API unreachable). */
  onStreamFailure: (detail: string) => void;
};

/**
 * Server-Sent Events replace the old refetchInterval polling loop: verification-svc pushes a new event on
 * every real status change. The route is `jobEventsPath` — not in `openapi.json`, so not generated.
 */
export const useJobEventStream = (
  jobId: string | null,
  handlers: JobStreamHandlers,
) => {
  // Held in a ref so a re-render never tears down and re-opens the stream: the effect must depend on the job id
  // alone, but the handlers need this render's state.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!jobId) return;
    // "" is same-origin and valid — only an unconfigured bundle (undefined) skips the stream.
    const apiBase = getApiBase();
    if (apiBase === undefined) return;

    const eventSource = new EventSource(`${apiBase}${jobEventsPath(jobId)}`);
    let closedByClient = false;
    const closeStream = () => {
      closedByClient = true;
      eventSource.close();
    };

    eventSource.onmessage = (event) => {
      let data: JobResponse;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.status === "queued" || data.status === "running") {
        handlersRef.current.onProgress(
          data,
          data.progress?.detail || data.progress?.step || data.detail,
        );
        return;
      }

      const terminal: TerminalSubmissionState =
        data.status && data.status !== "idle" && data.status !== "submitting"
          ? data.status
          : "error";
      handlersRef.current.onTerminal(terminal, data);
      // The server has already ended the response at this point (its Observable completed) — closing here too
      // is what stops the browser's default EventSource auto-reconnect.
      closeStream();
    };

    eventSource.onerror = () => {
      if (closedByClient) return;
      // `readyState === CONNECTING` means the browser is already retrying a transient drop on its own.
      if (eventSource.readyState !== EventSource.CLOSED) return;
      handlersRef.current.onStreamFailure("Unable to reach verification API.");
      closeStream();
    };

    return closeStream;
  }, [jobId]);
};
