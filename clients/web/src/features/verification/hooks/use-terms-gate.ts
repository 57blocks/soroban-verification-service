import { useState } from "react";
import { useLegalDocuments } from "@/hooks/use-legal-documents";

export const useTermsGate = () => {
  const [accepted, setAccepted] = useState(false);
  const [refused, setRefused] = useState(false);

  const legal = useLegalDocuments();
  const gate = buildTermsGate(legal, accepted);

  const onAcceptedChange = (next: boolean) => {
    setAccepted(next);
    if (next) setRefused(false);
  };

  return {
    gate,
    refuse: () => setRefused(true),
    props: {
      accepted,
      onAcceptedChange,
      ...(gate.unavailableReason ? { disabledReason: gate.unavailableReason } : {}),
      ...(refused && gate.blockedReason ? { error: gate.blockedReason } : {}),
    },
  };
};

type TermsGate = {
  blockedReason?: string;
  unavailableReason?: string;
  version?: string;
};

function buildTermsGate(legal: ReturnType<typeof useLegalDocuments>, accepted: boolean): TermsGate {
  if (legal.isLoading) {
    const reason = "The terms are still loading.";
    return { blockedReason: reason, unavailableReason: reason };
  }
  if (legal.isError || !legal.bundle) {
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
