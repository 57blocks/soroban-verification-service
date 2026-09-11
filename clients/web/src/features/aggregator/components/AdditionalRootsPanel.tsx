import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdditionalRoot } from "../hooks/use-additional-roots";
import { PeerLink } from "./PeerLink";

type AdditionalRootsPanelProps = {
  roots: readonly AdditionalRoot[];
  onAdd: (url: string) => string | null;
  onRemove: (id: string) => void;
};

/** Result roots the reader adds for this session, asked alongside the Trusted Verifiers List. */
export const AdditionalRootsPanel = ({ roots, onAdd, onRemove }: AdditionalRootsPanelProps) => {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <p className="m-0 max-w-[62ch] text-[0.8rem] text-ink-muted">
        Roots this deployment does not aggregate across. The browser fetches them directly and their
        answers are reported separately below — never merged into the aggregate, which is a claim
        only this deployment can make. <strong>They are gone on reload.</strong>
      </p>

      <form
        className="mt-4 flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const problem = onAdd(input);
          setError(problem);
          if (problem === null) setInput("");
        }}
      >
        <Input
          aria-label="Additional result root"
          placeholder="https://verifier.example/public"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="max-w-[30rem] font-mono"
        />
        <Button type="submit" variant="outline">
          Add root
        </Button>
      </form>

      {error && (
        <p className="mb-0 mt-2 text-[0.8rem] text-ink-muted" data-testid="additional-root-error">
          {error}
        </p>
      )}

      <ul className="mt-4 space-y-2 pl-0" data-testid="additional-roots-list">
        {roots.map((root) => (
          <li
            key={root.id}
            className="flex list-none flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2"
          >
            {/* Behind the interstitial like any other peer-origin URL (S26) — the reader typed it,
                but the page still must not turn it into a live link without showing the origin. */}
            <PeerLink url={root.url} label="root" />
            <button
              type="button"
              aria-label={`Remove ${root.url}`}
              onClick={() => onRemove(root.id)}
              className="ml-auto inline-flex items-center gap-1 border-0 bg-transparent p-0 text-[0.75rem] text-ink-muted hover:text-ink"
            >
              <X size={12} aria-hidden />
              Remove
            </button>
          </li>
        ))}
        {roots.length === 0 && (
          <li className="list-none text-[0.8rem] text-ink-muted">
            None added. Answers below come from the Trusted Verifiers List alone.
          </li>
        )}
      </ul>
    </div>
  );
};
