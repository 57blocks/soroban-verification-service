import { resultRootOf } from "soroban-verification-client";
import { transportFailureCopy } from "../hooks/query-api";
import { useTrustedVerifiers } from "../hooks/use-trusted-verifiers";
import { LoadingRow, MutedNote } from "./Feedback";
import { PeerLink } from "./PeerLink";

/** The three states `TrustedVerifier.status` can hold. */
const statusTone: Record<string, string> = {
  active: "bg-success-fg",
  paused: "bg-warning-fg",
  disabled: "bg-danger-fg",
};

/**
 * The Trusted Verifiers List — the set of verifiers this deployment aggregates across, and so the set every
 * answer on the other tabs was assembled from.
 */
export const TrustedVerifiers = () => {
  const { list, isLoading, failure } = useTrustedVerifiers();

  if (isLoading) return <LoadingRow>Reading the Trusted Verifiers List…</LoadingRow>;

  if (failure) {
    return (
      <MutedNote testId="tvl-failed">The list could not be read: {transportFailureCopy(failure)}</MutedNote>
    );
  }

  // `?? []` rather than `list?.verifiers.map` — the optional chain stops at `list`, so a 200 whose body lacks
  // `verifiers` would throw during render, and nothing in this app catches that.
  const verifiers = list?.verifiers ?? [];

  return (
    <div>
      <p className="m-0 max-w-[62ch] text-[0.8rem] text-ink-muted">
        Who this deployment aggregates across. A verifier that is not <code>active</code> is skipped
        when an answer is assembled — that is the operator&apos;s own decision, not a claim about the
        verifier.
      </p>

      <ul className="mt-6 space-y-3 pl-0" data-testid="tvl-list">
        {verifiers.map((verifier, index) => {
          // This page is typed against the CONSUMER list, so `display_name` and `id` are both optional —
          // the published schema requires only `url` and `status`. Falling back to the result root and not
          // to `id` is the SEP's own order: the root is the identity, `id` is implementation-local and
          // means nothing outside the aggregator that minted it.
          const root = resultRootOf(verifier);
          const heading = verifier.display_name ?? root ?? "An entry naming neither a label nor a root";
          return (
          <li
            // The root first, for the same reason the heading prefers it: a list cannot hold two entries
            // with the same result root, because the same root IS the same verifier — so it is the only
            // field here that is unique by definition. `id` is implementation-local and carries no such
            // promise: two entries with different roots may well share one, and keying on it would
            // reconcile them into a single row. It stays as a second choice only to separate two entries
            // that name no root at all, with the index as the last resort when even that is missing.
            key={root ?? verifier.id ?? `entry-${index}`}
            className="list-none rounded-lg border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-display text-[1rem] font-semibold text-ink">{heading}</span>
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block size-2 rounded-full ${statusTone[verifier.status] ?? "bg-warning-fg"}`}
                />
                <span className="font-mono text-[0.8rem] text-ink-value">{verifier.status}</span>
              </span>
            </div>
            {/* Only when it says something the heading did not. `trusted_verifiers` has no
                display_name column, so query-svc falls `display_name` back to the id — rendering
                both would print one string twice. This survives the column being added, and an entry
                carrying no id at all has nothing to add here. */}
            {verifier.id !== undefined && verifier.id !== heading && (
              <p className="mb-0 mt-1 break-all font-mono text-[0.75rem] text-ink-muted">{verifier.id}</p>
            )}
            <div className="mt-3 space-y-1">
              {/* Either spelling of the result root, and an entry naming neither says so rather than
                  rendering an empty destination. */}
              {root ? (
                <PeerLink url={root} label="url" />
              ) : (
                <p className="m-0 text-[0.75rem] text-ink-muted" data-testid="tvl-no-result-root">
                  Names no result root, so nothing of this verifier&apos;s can be read.
                </p>
              )}
              {/* How this peer's hash set is discovered, which decides what it can contribute.
                  With a bulk-load route it is enumerated from its own stream. Without one it is
                  still a full member — asked per hash from a rotating scan of our own
                  index — but that scan can only ask about hashes we already know, so a result only
                  this peer holds stays invisible until someone names that hash. Worth saying on the
                  page whose job is what the aggregate is made of. */}
              {verifier.bulk_load_url ? (
                <PeerLink url={verifier.bulk_load_url} label="bulk_load_url" />
              ) : (
                <p className="m-0 text-[0.75rem] text-ink-muted" data-testid="tvl-not-enumerable">
                  Serves no bulk-load route — asked per hash from hashes already known here, so a
                  result only this verifier holds stays unseen until someone looks it up.
                </p>
              )}
            </div>
          </li>
          );
        })}
        {verifiers.length === 0 && (
          <li className="list-none text-[0.9rem] text-ink-muted">
            The list is empty — this deployment aggregates across nobody, so it can answer nothing.
          </li>
        )}
      </ul>
    </div>
  );
};
