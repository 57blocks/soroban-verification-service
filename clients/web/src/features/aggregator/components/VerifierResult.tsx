import type { PeerRegistryVerification } from "@scvs/sdk";
import { cn } from "@/lib/utils";
import { PeerLink } from "./PeerLink";

/**
 * A peer entry, from either place this card is used: an aggregate assembled by query-svc, or a verifier's own
 * document read straight from its root by the client-side fan-out.
 */
type VerifierResultProps = {
  entry: PeerRegistryVerification & { schema_version?: string; retrieved_at?: string };
};

const statusTone: Record<string, string> = {
  verified: "bg-success-fg",
  mismatched: "bg-danger-fg",
  unverified: "bg-warning-fg",
};

/** One verifier's published answer. */
export const VerifierResult = ({ entry }: VerifierResultProps) => (
  <li
    data-testid="verifier-result"
    className="list-none rounded-lg border border-line bg-surface p-4"
  >
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* `name` is self-claimed and optional; `url` is the identity, and is what a reader can check. */}
      <span className="font-display text-[1rem] font-semibold text-ink">
        {entry.verifier.name ?? entry.verifier.url}
      </span>
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden
          className={cn("inline-block size-2 rounded-full", statusTone[entry.status] ?? "bg-warning-fg")}
        />
        <span className="font-mono text-[0.8rem] text-ink-value">{entry.status}</span>
      </span>
    </div>

    <dl className="mt-3 space-y-1 text-[0.75rem] text-ink-muted">
      {entry.recipe_source && <Row label="recipe_source" value={entry.recipe_source} />}
      {entry.image_trust_level && <Row label="image_trust_level" value={entry.image_trust_level} />}
      {/* A peer still on the Registry API draft's shape says this with one boolean instead. */}
      {!entry.recipe_source && entry.out_of_band && (
        <div>Established outside SEP-58&apos;s reproducible-build mechanisms (out of band).</div>
      )}
      {entry.processed_at && <Row label="processed_at" value={entry.processed_at} />}
      {entry.rebuilt_hash && <Row label="rebuilt_hash" value={entry.rebuilt_hash} />}
      {entry.bldimg && <Row label="bldimg" value={entry.bldimg} />}
      {entry.bldopt && entry.bldopt.length > 0 && <Row label="bldopt" value={entry.bldopt.join(" ")} />}
      {/* `retrieved_at` marks a retained copy rather than a live read (AB5) — worth showing on a
          page whose whole job is watching publication land. */}
      {entry.retrieved_at && <Row label="retrieved_at (retained copy)" value={entry.retrieved_at} />}
    </dl>

    <div className="mt-3 space-y-1">
      {entry.verifier.url && <PeerLink url={entry.verifier.url} label="verifier" />}
      {entry.source_repo && <PeerLink url={entry.source_repo} label="source_repo" />}
    </div>
  </li>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex flex-wrap gap-2">
    <dt className="shrink-0">{label}</dt>
    <dd className="m-0 break-all font-mono text-ink-value">{value}</dd>
  </div>
);
