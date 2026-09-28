import { useEffect, useRef } from "react";
import { jobEventsPath } from "@scvs/verify-api-client";
import { getApiBase } from "@/lib/http";
import type { JobResponse, TerminalSubmissionState } from "../types";

type JobStreamHandlers = {
  onProgress: (data: JobResponse, detail?: string) => void;
  onTerminal: (state: TerminalSubmissionState, data: JobResponse) => void;
  onStreamFailure: (detail: string) => void;
};

export const useJobEventStream = (
  jobId: string | null,
  handlers: JobStreamHandlers,
) => {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!jobId) return;
    // "" is same-origin and valid; only an unconfigured bundle (undefined) skips the stream.
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
      // Closing here too is what stops EventSource's default auto-reconnect.
      closeStream();
    };

    eventSource.onerror = () => {
      if (closedByClient) return;
      // `readyState === CONNECTING` means the browser is already retrying a transient drop.
      if (eventSource.readyState !== EventSource.CLOSED) return;
      handlersRef.current.onStreamFailure("Unable to reach verification API.");
      closeStream();
    };

    return closeStream;
  }, [jobId]);
};
