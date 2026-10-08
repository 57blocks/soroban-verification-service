import type { PeerRegistryVerification } from "soroban-verification-client";
import { cn } from "@/lib/utils";
import { PeerLink } from "./PeerLink";

type VerifierResultProps = {
  entry: PeerRegistryVerification & { schema_version?: string; retrieved_at?: string };
};

const statusTone: Record<string, string> = {
  verified: "bg-success-fg",
  mismatched: "bg-danger-fg",
  unverified: "bg-warning-fg",
};

export const VerifierResult = ({ entry }: VerifierResultProps) => {
  const sourceCopies = (entry.verified_source_code_uris ?? []).map(asLink);

  return (
    <li
      data-testid="verifier-result"
      className="list-none rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[1rem] font-semibold text-ink">
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

      <dl className="mt-3 space-y-1 text-[0.75rem] text-ink-mute">
        {entry.verifier.url && <Row label="verifier" value={entry.verifier.url} />}
        {entry.recipe_source && <Row label="recipe_source" value={entry.recipe_source} />}
        {entry.image_trust_level && <Row label="image_trust_level" value={entry.image_trust_level} />}
        {!entry.recipe_source && entry.out_of_band && (
          <div>Established outside SEP-58&apos;s reproducible-build mechanisms (out of band).</div>
        )}
        {entry.processed_at && <Row label="processed_at" value={entry.processed_at} />}
        {entry.rebuilt_hash && <Row label="rebuilt_hash" value={entry.rebuilt_hash} />}
        {entry.bldimg && <Row label="bldimg" value={entry.bldimg} />}
        {entry.bldopt && entry.bldopt.length > 0 && <Row label="bldopt" value={entry.bldopt.join(" ")} />}
        {entry.source_sha256 && <Row label="source_sha256" value={entry.source_sha256} />}
        {entry.retrieved_at && <Row label="retrieved_at (retained copy)" value={entry.retrieved_at} />}
      </dl>

      <div className="mt-3 space-y-1" data-testid="verifier-result-links">
        {entry.source_uri && <PeerLink url={entry.source_uri} label="source_uri" />}
        {entry.source_repo && <PeerLink url={entry.source_repo} label="source_repo" />}
        {sourceCopies.map((link, index) => (
          <PeerLink key={`source-${index}`} url={link.url} label={labelOf("source", link.location)} />
        ))}
      </div>
    </li>
  );
};

type Link = { url: string; location?: string };

const asLink = (value: string | Link): Link => (typeof value === "string" ? { url: value } : value);

const labelOf = (kind: string, location?: string) => (location ? `${kind} (${location})` : kind);

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex gap-2">
    <dt className="shrink-0">{label}</dt>
    <dd className="m-0 min-w-0 break-all font-mono text-ink-value">{value}</dd>
  </div>
);
