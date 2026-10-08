import { resultRootOf } from "soroban-verification-client";
import { transportFailureCopy } from "../hooks/query-api";
import { useTrustedVerifiers } from "../hooks/use-trusted-verifiers";
import { LoadingRow, MutedNote } from "./Feedback";
import { PeerLink } from "./PeerLink";

const statusTone: Record<string, string> = {
  active: "bg-success-fg",
  paused: "bg-warning-fg",
  disabled: "bg-danger-fg",
};

export const TrustedVerifiers = () => {
  const { list, isLoading, failure } = useTrustedVerifiers();

  if (isLoading) return <LoadingRow>Reading the Trusted Verifiers List…</LoadingRow>;

  if (failure) {
    return (
      <MutedNote testId="tvl-failed">The list could not be read: {transportFailureCopy(failure)}</MutedNote>
    );
  }

  // Not `list?.verifiers.map`: the chain stops at `list`, so a body lacking `verifiers` would throw in render.
  const verifiers = list?.verifiers ?? [];

  return (
    <div>
      <p className="m-0 max-w-[62ch] text-[0.8rem] text-ink-body">
        Who this deployment aggregates across. A <code>paused</code> verifier is not asked for new
        results, but its last answer is still shown with its age; a <code>disabled</code> one&apos;s
        answers are neither shown nor counted. Either is the operator&apos;s own decision, not a claim
        about the verifier.
      </p>

      <ul className="mt-6 space-y-3 pl-0" data-testid="tvl-list">
        {verifiers.map((verifier, index) => {
          const root = resultRootOf(verifier);
          const heading = verifier.display_name ?? root ?? "An entry naming neither a label nor a root";
          return (
          <li
            // The result root is the only field unique by definition; `id` may repeat across entries.
            key={root ?? verifier.id ?? `entry-${index}`}
            className="list-none rounded-lg border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[1rem] font-semibold text-ink">{heading}</span>
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block size-2 rounded-full ${statusTone[verifier.status] ?? "bg-warning-fg"}`}
                />
                <span className="font-mono text-[0.8rem] text-ink-value">{verifier.status}</span>
              </span>
            </div>
            {verifier.id !== undefined && verifier.id !== heading && (
              <p className="mb-0 mt-1 break-all font-mono text-[0.75rem] text-ink-mute">{verifier.id}</p>
            )}
            <div className="mt-3 space-y-1">
              {root ? (
                <div className="flex gap-2 text-[0.75rem]" data-testid="tvl-result-root">
                  <span className="shrink-0 text-ink-mute">url</span>
                  <span className="min-w-0 break-all font-mono text-ink-value">{root}</span>
                </div>
              ) : (
                <p className="m-0 text-[0.75rem] text-ink-mute" data-testid="tvl-no-result-root">
                  Names no result root, so nothing of this verifier&apos;s can be read.
                </p>
              )}
              {verifier.manifest_url && <PeerLink url={verifier.manifest_url} label="manifest_url" />}
              {verifier.bulk_load_url ? (
                <PeerLink url={verifier.bulk_load_url} label="bulk_load_url" />
              ) : (
                <p className="m-0 text-[0.75rem] text-ink-mute" data-testid="tvl-not-enumerable">
                  Serves no bulk-load route — asked per hash from hashes already known here, so a
                  result only this verifier holds stays unseen until someone looks it up.
                </p>
              )}
            </div>
          </li>
          );
        })}
        {verifiers.length === 0 && (
          <li className="list-none text-[0.9rem] text-ink-body">
            The list is empty — this deployment aggregates across nobody, so it can answer nothing.
          </li>
        )}
      </ul>
    </div>
  );
};
