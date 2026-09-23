import { useQuery } from "@tanstack/react-query";
import { getBuildLogWithToken, type BuildLogUnavailableResponse } from "@scvs/verify-api-client";
import { isApiBaseConfigured, isHttpError } from "@/lib/http";
import { readBuildLogToken } from "../utils/build-log-tokens.store";
import type { BuildLogState } from "../types";

/**
 * The raw redacted build log for a terminal job (UI2), behind this job's token
 * (build-log-access design.md BL-1).
 *
 * Through `getBuildLogWithToken`, not the generated `getBuildLog`, which has no way to send the header the
 * route requires. The token is read here, from this feature's `localStorage`, and handed over as an argument
 * — the client package never reads storage, which is what keeps it environment-agnostic. What this hook owns
 * is the ladder below: which answer means which panel.
 */
export const useBuildLog = (jobId: string | null, enabled: boolean) => {
  const token = readBuildLogToken(jobId);

  const query = useQuery({
    queryKey: ["build-log", jobId],
    // Without a token there is nothing to ask for: the request would answer 401 every time, so the panel
    // explains instead of retrying.
    enabled: enabled && Boolean(jobId) && Boolean(token) && isApiBaseConfigured(),
    // A log is written once and never rewritten, so re-fetching on focus is pure noise.
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const res = await getBuildLogWithToken(jobId as string, token as string);
      return res.data;
    },
  });

  const state = ((): BuildLogState => {
    if (!enabled || !jobId) return { phase: "idle" };
    // The shared-link case, and the intended one: this browser did not create the job, so it holds no
    // token and the raw log is not its to read.
    if (!token) return { phase: "needs-token" };
    if (query.isPending) return { phase: "loading" };

    if (query.isSuccess) {
      const log = typeof query.data === "string" ? query.data : "";
      // A 200 whose body is empty is still "there is no output", not "the log is missing".
      return log.trim().length > 0 ? { phase: "log", text: log } : { phase: "empty" };
    }

    const error = query.error;
    if (isHttpError(error)) {
      const status = error.response?.status;
      // The token this browser holds is not this job's — indistinguishable from a job that does not exist,
      // which is the point of the ladder.
      if (status === 401 || status === 404) {
        const body = error.response?.data as BuildLogUnavailableResponse | undefined;
        // A 404 carrying the unavailable body is "this job produced no log"; a bare one is "not yours".
        return body && "job_status" in body
          ? { phase: "unavailable", body }
          : { phase: "needs-token" };
      }
      if (status === 410) return { phase: "expired" };
    }

    return { phase: "unreadable" };
  })();

  return state;
};
