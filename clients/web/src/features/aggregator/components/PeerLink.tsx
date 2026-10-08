import { useState } from "react";

type PeerLinkProps = {
  url: string;
  label: string;
};

export const PeerLink = ({ url, label }: PeerLinkProps) => {
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedFor, setConfirmedFor] = useState(url);
  if (confirmedFor !== url) {
    setConfirmedFor(url);
    setConfirmed(false);
  }
  const destination = safeDestination(url);

  if (!destination) {
    return (
      <div className="break-all font-mono text-[0.75rem] text-ink-mute" data-testid="peer-link-refused">
        {label}: refused — not an http(s) destination
      </div>
    );
  }

  return (
    <div className="flex gap-2 text-[0.75rem]">
      <span className="shrink-0 text-ink-mute">{label}</span>
      <span className="min-w-0">
        {confirmed ? (
          <a
            href={destination.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="peer-link-open"
            className="break-all font-mono text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink"
          >
            {destination.href}
          </a>
        ) : (
          <>
            {/* Text, not an anchor: nothing is navigable before the destination has been shown. */}
            <span className="break-all font-mono text-ink-value" data-testid="peer-link-pending">
              {destination.href}
            </span>{" "}
            <button
              type="button"
              onClick={() => setConfirmed(true)}
              className="border-0 bg-transparent p-0 text-[0.75rem] font-bold text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
            >
              show link
            </button>
          </>
        )}
      </span>
    </div>
  );
};

const safeDestination = (url: string): URL | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
};
