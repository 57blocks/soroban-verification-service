import { useState } from "react";
import { useLegalDocuments } from "@/hooks/use-legal-documents";

/**
 * The terms acceptance a submission requires, and whether the console may make one right now.
 *
 * Out of `useVerificationConsole` because it is self-contained: two pieces of state, one query, and a rule —
 * the submission paths only ever *read* the verdict and report a refusal.
 */
export const useTermsGate = () => {
  const [accepted, setAccepted] = useState(false);
  /** Set by a submission the gate turned away, so the refusal is on the page and not only in a toast. */
  const [refused, setRefused] = useState(false);

  // The operator's bundle: its `version` is what a submission binds, and its absence is what blocks one.
  const legal = useLegalDocuments();
  const gate = buildTermsGate(legal, accepted);

  const onAcceptedChange = (next: boolean) => {
    setAccepted(next);
    if (next) setRefused(false);
  };

  return {
    gate,
    /** Called by a submission path the gate turned away. */
    refuse: () => setRefused(true),
    /** What the acceptance control renders. */
    props: {
      accepted,
      onAcceptedChange,
      ...(gate.unavailableReason ? { disabledReason: gate.unavailableReason } : {}),
      // Only after a refused press. The block states what it wants before then; it does not open in red.
      ...(refused && gate.blockedReason ? { error: gate.blockedReason } : {}),
    },
  };
};

type TermsGate = {
  /** Why a submission is refused, or `undefined` when it is not. */
  blockedReason?: string;
  /** Why the acceptance control itself cannot be used — a narrower set than `blockedReason`. */
  unavailableReason?: string;
  version?: string;
};

/**
 * The console requires the affirmative act unconditionally. The operator's `effective_date` governs whether
 * the *server* rejects a submission that carries no accepted version, not whether this browser offers to
 * make one — a control that can be ignored is not the gate TA-1 describes.
 */
function buildTermsGate(legal: ReturnType<typeof useLegalDocuments>, accepted: boolean): TermsGate {
  if (legal.isLoading) {
    const reason = "The terms are still loading.";
    return { blockedReason: reason, unavailableReason: reason };
  }
  if (legal.isError || !legal.bundle) {
    // Nothing to accept, so nothing may be submitted: a job must never be bound to text nobody was shown.
    const reason = "The terms could not be loaded, so nothing can be submitted right now.";
    return { blockedReason: reason, unavailableReason: reason };
  }
  const { version } = legal.bundle;
  if (!accepted) {
    return {
      blockedReason: "Accept the Terms of Service and acknowledge the Privacy Notice before submitting.",
      version,
    };
  }
  return { version };
}
