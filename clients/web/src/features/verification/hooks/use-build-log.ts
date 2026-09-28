import { useQuery } from "@tanstack/react-query";
import { getBuildLog, type BuildLogUnavailableResponse } from "@scvs/verify-api-client";
import { isApiBaseConfigured, isHttpError } from "@/lib/http";
import { readBuildLogToken } from "../utils/build-log-tokens.store";
import type { BuildLogState } from "../types";

export const useBuildLog = (jobId: string | null, enabled: boolean) => {
  const token = readBuildLogToken(jobId);

  const query = useQuery({
    queryKey: ["build-log", jobId],
    enabled: enabled && Boolean(jobId) && Boolean(token) && isApiBaseConfigured(),
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const res = await getBuildLog(jobId, { "x-build-log-token": token as string });
      return res.data;
    },
  });

  const state = ((): BuildLogState => {
    if (!enabled || !jobId) return { phase: "idle" };
    if (!token) return { phase: "needs-token" };
    if (query.isPending) return { phase: "loading" };

    if (query.isSuccess) {
      const log = typeof query.data === "string" ? query.data : "";
      return log.trim().length > 0 ? { phase: "log", text: log } : { phase: "empty" };
    }

    const error = query.error;
    if (isHttpError(error)) {
      const status = error.response?.status;
      if (status === 401 || status === 404) {
        const body = error.response?.data as BuildLogUnavailableResponse | undefined;
        // A 404 carrying the unavailable body means "no log"; a bare one means "not yours".
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
