import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { QueryApiFailure } from "soroban-verification-client";
import type { LookupState } from "../types";
import { AggregatedStatusView } from "./AggregatedStatusView";
import { LoadingRow, MutedNote } from "./Feedback";
import { UnavailableVerifiers } from "./UnavailableVerifiers";

type LookupResultProps = {
  state: LookupState & { refresh: () => void };
  /** `hash` / `contract` — the suite queries `<prefix>-invalid`, `-failed`, `-empty`. */
  testIdPrefix: string;
  invalidCopy: ReactNode;
  loadingCopy: string;
  failureCopy: (failure: QueryApiFailure) => string;
};

/** The outcome of either lookup, so the two tabs cannot answer the same situation differently. */
export const LookupResult = ({
  state,
  testIdPrefix,
  invalidCopy,
  loadingCopy,
  failureCopy,
}: LookupResultProps) => {
  switch (state.phase) {
    case "idle":
      return null;

    case "invalid":
      return <MutedNote testId={`${testIdPrefix}-invalid`}>{invalidCopy}</MutedNote>;

    case "loading":
      return <LoadingRow>{loadingCopy}</LoadingRow>;

    case "failed":
      return <MutedNote testId={`${testIdPrefix}-failed`}>{failureCopy(state.failure)}</MutedNote>;

    case "empty":
      return (
        <div data-testid={`${testIdPrefix}-empty`}>
          <p className="m-0 text-[0.95rem] font-medium text-ink">
            No result in this deployment&apos;s aggregate.
          </p>
          <p className="mb-0 mt-1 max-w-[58ch] text-[0.8rem] text-ink-body">
            This says what <em>this deployment</em> holds, not what any verifier has published — a
            result may exist and not have been retained here yet.
          </p>
          <Button type="button" variant="outline" className="mt-3" onClick={state.refresh}>
            Refresh
          </Button>
          <UnavailableVerifiers verifiers={state.status.unavailable_verifiers} />
        </div>
      );

    case "answered":
      return <AggregatedStatusView status={state.status} source="retained-aggregate" showHash />;
  }
};
