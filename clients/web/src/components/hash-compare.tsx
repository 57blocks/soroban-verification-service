import { cn } from "@/lib/utils";

/** Two digests to hold against each other, already split into the chunks the reader compares. */
export type HashComparison = { deployed: string[]; rebuilt: string[] };

/**
 * Two digests held against each other, chunk by chunk: deployed above, rebuilt below. A chunk the two disagree
 * on is marked in the mismatch tone — colour is not the only signal, the glyph between them changes too.
 *
 * Shared by the landing page's trust-model cards, which pass illustrative digests, and the console's result
 * panel, which passes the real ones.
 */
export const HashCompare = ({
  compare,
  className,
}: {
  compare: HashComparison;
  className?: string;
}) => (
  <div className={cn("flex flex-wrap gap-x-3.5 gap-y-2 font-mono", className)}>
    {compare.deployed.map((chunk, index) => {
      const rebuilt = compare.rebuilt[index];
      const same = chunk === rebuilt;

      return (
        <div key={chunk + index} className="flex w-[8ch] flex-col">
          <span
            className={`border-b-2 pb-1 text-sm ${same ? "border-yellow text-ink" : "border-danger-fg text-danger-fg"}`}
          >
            {chunk}
          </span>
          <span
            aria-hidden
            className={`py-1.5 text-center text-xs ${same ? "text-yellow-deep" : "text-danger-fg"}`}
          >
            {same ? "=" : "≠"}
          </span>
          <span
            className={`border-t-2 pt-1 text-sm ${same ? "border-yellow text-ink" : "border-danger-fg text-danger-fg"}`}
          >
            {rebuilt}
          </span>
        </div>
      );
    })}
  </div>
);
