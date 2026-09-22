import type { AggregatedWasmStatus } from "soroban-verification-client";

/** Verifiers this deployment could not reach. */
export const UnavailableVerifiers = ({
  verifiers,
}: {
  verifiers: AggregatedWasmStatus["unavailable_verifiers"];
}) => {
  if (verifiers.length === 0) return null;

  return (
    <div className="mt-6" data-testid="explorer-unavailable">
      <h2 className="m-0 text-xs font-bold uppercase tracking-[0.03em] text-ink">Could not be reached</h2>
      <ul className="mt-2 space-y-1 pl-0">
        {verifiers.map((verifier) => (
          <li key={verifier.url} className="list-none text-[0.8rem] text-ink-body">
            {verifier.name ?? verifier.url} — {verifier.reason}
            {verifier.error ? `: ${verifier.error}` : ""}
          </li>
        ))}
      </ul>
      <p className="mb-0 mt-2 text-[0.75rem] text-ink-mute">
        These verifiers may hold a result. Their absence above is not evidence either way.
      </p>
    </div>
  );
};
