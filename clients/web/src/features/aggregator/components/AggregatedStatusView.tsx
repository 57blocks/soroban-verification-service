import type { AggregatedWasmStatus } from "soroban-verification-client";

type Agreement = AggregatedWasmStatus["agreement"];
import { UnavailableVerifiers } from "./UnavailableVerifiers";
import { VerifierResult } from "./VerifierResult";

// Keyed by the union, not by `string`: a value added to `AgreementSummary` must fail the build rather than
// render as a raw token on a page whose job is not misstating a verdict.
const agreementCopy: Record<Agreement, string> = {
  single: "One verifier has a result for these bytes.",
  unanimous_verified: "Every verifier that answered reports these bytes verified.",
  unanimous_mismatched: "Every verifier that answered reports a mismatch.",
  disputed: "Verifiers disagree about these bytes. Read each answer below before relying on any of them.",
  unverified_only: "Verifiers hold records for these bytes, but none reports them verified.",
  no_data: "No trusted verifier has published a result for these bytes.",
};

/** Who assembled the answer, which is the only thing that decides what `updated_at` means. */
export type StatusSource = "peer-documents" | "retained-aggregate";

const assembledNote: Record<StatusSource, string> = {
  "peer-documents": "when we read the documents, never when a verifier published one.",
  // query-svc stamps every answer with `new Date()` as it serves it, so it is neither a publication time nor an
  // aggregation-change time.
  "retained-aggregate": "when this answer was assembled from the retained aggregate, not when it changed.",
};

type AggregatedStatusViewProps = {
  status: AggregatedWasmStatus;
  source: StatusSource;
  /** Shows the subject hash above the verdict, for the surfaces where it is not already on screen. */
  showHash?: boolean;
};

/** One aggregated answer, however it was assembled. */
export const AggregatedStatusView = ({ status, source, showHash }: AggregatedStatusViewProps) => (
  <div data-testid="explorer-results">
    {showHash && (
      <p className="m-0 mb-1 break-all font-mono text-[0.8rem] text-ink-muted">
        wasm_hash {status.wasm_hash}
      </p>
    )}
    <p className="m-0 text-[0.95rem] font-medium text-ink">
      {agreementCopy[status.agreement] ?? status.agreement}
    </p>
    <p className="mb-0 mt-1 text-[0.75rem] text-ink-muted">
      Assembled {status.updated_at} — this is {assembledNote[source]}
    </p>

    {status.source_code_verifications.length > 0 && (
      <ul className="mt-5 space-y-3 pl-0">
        {/* Keyed by the peer's URL, falling back to position. `verifier.name` must never be a key —
            it is free text a peer writes about itself. Position alone is not enough either: a
            PeerLink holds "the reader confirmed this origin" in state, so an entry inserted ahead of
            a confirmed one would slide a different URL under a live anchor. */}
        {status.source_code_verifications.map((entry, index) => (
          <VerifierResult key={entry.verifier.url ?? `#${index}`} entry={entry} />
        ))}
      </ul>
    )}

    <UnavailableVerifiers verifiers={status.unavailable_verifiers} />
  </div>
);
