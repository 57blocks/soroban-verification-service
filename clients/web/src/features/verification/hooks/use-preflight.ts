import { useCallback, useState } from "react";
import { usePreflightVerification } from "@scvs/verify-api-client";
import { errorMessage, isApiBaseConfigured } from "@/lib/http";
import type { PreflightState, TargetType, VerifyFormValues } from "../types";
import { normalizeWasmHash } from "../utils/manifest.util";
import { readVerdict } from "../utils/preflight.util";

const MISSING_API_URL_DETAIL = "VITE_VERIFY_API_URL is not configured for this build.";

/** Runs `POST /api/verification/v1/preflight` and holds its answer for the submission that follows. */
export const usePreflight = (form: { getValues: () => VerifyFormValues }) => {
  const [state, setState] = useState<PreflightState>({ phase: "idle" });
  const preflightMutation = usePreflightVerification();

  // Stable identity: the console resets on every target edit, and an unstable callback there would make the
  // effect re-run on each render and clear the answer the moment it arrived.
  const reset = useCallback(() => setState({ phase: "idle" }), []);

  const commit = (next: PreflightState): PreflightState => {
    setState(next);
    return next;
  };

  /**
   * Returns the resulting state as well as storing it: a caller that needs to act on the answer immediately
   * (prefilling the evidence form) cannot read `state` in the same tick, because the `setState` has not been
   * applied yet.
   */
  const run = async (targetType: TargetType): Promise<PreflightState> => {
    if (!isApiBaseConfigured()) {
      return commit({ phase: "failed", error: MISSING_API_URL_DETAIL });
    }

    const values = form.getValues();
    setState({ phase: "running" });

    try {
      const res = await preflightMutation.mutateAsync({
        data: {
          network: values.network,
          ...(targetType === "contract_id"
            ? { contract_id: values.contractId?.trim() }
            : { wasm_hash: normalizeWasmHash(values.wasmHash) }),
        },
      });

      const verdict = readVerdict(res.data.build_environment);
      return commit({
        phase: "answered",
        // An arm this build does not recognise blocks rather than passes.
        verdict: verdict ?? { gate: "blocked", label: "unrecognized" },
        response: res.data,
      });
    } catch (error) {
      return commit({
        phase: "failed",
        error: errorMessage(error, "Unable to reach the verification API."),
      });
    }
  };

  return { state, run, reset };
};

export type Preflight = ReturnType<typeof usePreflight>;
