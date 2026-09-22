import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdditionalRoot } from "../hooks/use-additional-roots";
import { lookupFailureCopy, useHashLookup } from "../hooks/use-hash-lookup";
import { useRootLookups } from "../hooks/use-root-lookups";
import { LookupResult } from "./LookupResult";
import { RootResults } from "./RootResults";

/** Look up one Wasm hash, in two places that must not be conflated. */
export const HashLookup = ({ additionalRoots = [] }: { additionalRoots?: readonly AdditionalRoot[] }) => {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const state = useHashLookup(submitted);
  // The same nonce reaches both sources, so one press re-asks the roots as well as the aggregate.
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
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </form>

      {/* Nothing below the form until something was asked — an empty section is a heading with no
          subject. And the headings only earn their place once there are two sources to tell apart:
          with no additional roots there is one answer, and naming its origin is noise. */}
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

      {/* Its own section, never merged into the aggregate above. The aggregate is a claim about a
          curated set; these are roots the reader added a minute ago, and folding them in would put
          words in this deployment's mouth. */}
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
