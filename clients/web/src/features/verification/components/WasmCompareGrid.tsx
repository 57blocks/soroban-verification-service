import { wasmCompareSummaryEntries } from "../utils/diagnostics.util";
import { MetaTile } from "./MetaTile";
import { MutedLabel } from "./MutedLabel";

/** Deployed vs rebuilt Wasm, one tile per dimension — green when equal, red when not. */
export const WasmCompareGrid = ({
  compare,
}: {
  compare: Record<string, unknown>;
}) => (
  <div>
    <MutedLabel className="mb-2">Wasm comparison</MutedLabel>
    <div className="grid gap-3 text-[0.875rem] md:grid-cols-2">
      {wasmCompareSummaryEntries(compare).map((entry) => (
        <MetaTile
          key={entry.label}
          label={entry.label}
          value={entry.value}
          detail={entry.detail}
          valueClassName={
            entry.value === "Same"
              ? "text-success-fg"
              : entry.value === "Different"
                ? "text-danger-fg"
                : "text-ink"
          }
        />
      ))}
    </div>
  </div>
);
