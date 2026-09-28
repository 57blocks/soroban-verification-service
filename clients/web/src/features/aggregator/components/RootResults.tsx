import type { RootResult } from "../hooks/use-root-lookups";
import { LoadingRow } from "./Feedback";
import { VerifierResult } from "./VerifierResult";

export const RootResults = ({ results }: { results: readonly RootResult[] }) => (
  <ul className="space-y-4 pl-0" data-testid="additional-root-results">
    {results.map((result) => (
      <li key={result.root.id} className="list-none rounded-lg border border-line bg-surface p-4">
        <p className="m-0 break-all font-mono text-[0.75rem] text-ink-mute">{result.root.url}</p>

        {result.phase === "loading" && (
          <div className="mt-2">
            <LoadingRow>Fetching…</LoadingRow>
          </div>
        )}

        {result.phase === "absent" && (
          <p className="mb-0 mt-2 text-[0.85rem] text-ink-body">
            Publishes nothing for these bytes — it answered 404, which is how a result root says it
            holds no record.
          </p>
        )}

        {result.phase === "failed" && (
          <p className="mb-0 mt-2 text-[0.85rem] text-ink-body">Could not be read: {result.error}</p>
        )}

        {result.phase === "answered" && (
          <>
            <p className="mb-0 mt-2 text-[0.75rem] text-ink-mute">
              Published {result.document.updated_at} — this root&apos;s own clock.
            </p>
            <ul className="mt-3 space-y-3 pl-0">
              {/* Keyed by URL, never by `verifier.name`: that is free text a peer writes about itself. */}
              {result.document.source_code_verifications.map((entry, index) => (
                <VerifierResult key={entry.verifier.url ?? `#${index}`} entry={entry} />
              ))}
            </ul>
          </>
        )}
      </li>
    ))}
  </ul>
);
