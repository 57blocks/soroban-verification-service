import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { Input } from "@/components/ui/input";
import type { AdditionalRoot } from "../hooks/use-additional-roots";
import { lookupFailureCopy, useHashLookup } from "../hooks/use-hash-lookup";
import { useRootLookups } from "../hooks/use-root-lookups";
import { LookupResult } from "./LookupResult";
import { RootResults } from "./RootResults";

export const HashLookup = ({ additionalRoots = [] }: { additionalRoots?: readonly AdditionalRoot[] }) => {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const state = useHashLookup(submitted);
  const rootResults = useRootLookups(additionalRoots, submitted, attempt);

  const refreshAll = () => {
    state.refresh();
    setAttempt((count) => count + 1);
  };
  const hasRoots = additionalRoots.length > 0;

  return (
    <div>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(input.trim());
          refreshAll();
        }}
      >
        <Input
          aria-label="Wasm hash"
          placeholder="64-character hex Wasm hash"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="max-w-[38rem] font-mono"
        />
        <Button type="submit">
          Look up
          <PillIcon animated>→</PillIcon>
        </Button>
      </form>

      {state.phase !== "idle" && (
        <div className="mt-8">
          {hasRoots && (
            <>
              <h2 className="m-0 text-xs font-bold uppercase tracking-[0.03em] text-ink">
                Trusted verifiers
              </h2>
              <p className="mb-4 mt-1 text-[0.75rem] text-ink-mute">
                This deployment&apos;s aggregate, assembled from the roots it syncs.
              </p>
            </>
          )}
          <LookupResult
            state={{ ...state, refresh: refreshAll }}
            testIdPrefix="hash"
            invalidCopy="A Wasm hash is 64 hex characters. Nothing was queried."
            loadingCopy="Reading this deployment's aggregate…"
            failureCopy={lookupFailureCopy}
          />
        </div>
      )}

      {hasRoots && state.phase !== "idle" && state.phase !== "invalid" && (
        <section className="mt-10" aria-labelledby="roots-answer-heading">
          <h2
            id="roots-answer-heading"
            className="m-0 text-xs font-bold uppercase tracking-[0.03em] text-ink"
          >
            Additional result roots
          </h2>
          <p className="mb-4 mt-1 text-[0.75rem] text-ink-mute">
            Fetched by your browser, one at a time, straight from each root. Not part of the
            aggregate above.
          </p>
          <RootResults results={rootResults} />
        </section>
      )}
    </div>
  );
};
