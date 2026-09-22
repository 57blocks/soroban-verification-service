import { useState } from "react";

type PeerLinkProps = {
  url: string;
  label: string;
};

/** Every part of this is about one fact: **the destination is peer-controlled**. */
export const PeerLink = ({ url, label }: PeerLinkProps) => {
  const [confirmed, setConfirmed] = useState(false);
  // Confirmation is about *this* destination.
  const [confirmedFor, setConfirmedFor] = useState(url);
  if (confirmedFor !== url) {
    setConfirmedFor(url);
    setConfirmed(false);
  }
  const destination = safeDestination(url);

  if (!destination) {
    return (
      <span className="break-all font-mono text-[0.75rem] text-ink-mute" data-testid="peer-link-refused">
        {label}: refused — not an http(s) destination
      </span>
    );
  }

  if (!confirmed) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-2">
        {/* Text, not an anchor: nothing is navigable before the origin has been shown. */}
        <span className="break-all font-mono text-[0.75rem] text-ink-mute" data-testid="peer-link-pending">
          {label}: {destination.origin}
        </span>
        <button
          type="button"
          onClick={() => setConfirmed(true)}
          className="border-0 bg-transparent p-0 text-[0.75rem] font-bold text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
        >
          show link
        </button>
      </span>
    );
  }

  return (
    <a
      href={destination.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="peer-link-open"
      className="break-all font-mono text-[0.75rem] text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink"
    >
      {destination.href}
    </a>
  );
};

/** `null` for anything that is not an absolute http(s) URL. */
const safeDestination = (url: string): URL | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
};
