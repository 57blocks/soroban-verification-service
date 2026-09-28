import { MonoChip } from "@/components/mono-chip";
import { cn } from "@/lib/utils";
import { wasmCompareSummaryEntries } from "../utils/diagnostics.util";
import { MonoLabel } from "./MonoLabel";

const verdictTone = (value: string) => {
  if (value === "Same") return "text-success-fg";
  if (value === "Different") return "text-danger-fg";
  return "text-ink-mute";
};

export const WasmCompareGrid = ({
  compare,
}: {
  compare: Record<string, unknown>;
}) => (
  <div>
    <MonoLabel className="mb-2.5">Wasm comparison</MonoLabel>
    <div className="grid gap-3 md:grid-cols-2">
      {wasmCompareSummaryEntries(compare).map((entry) => (
        <div key={entry.label} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <MonoLabel>{entry.label}</MonoLabel>
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.12em]",
                verdictTone(entry.value),
              )}
            >
              {entry.value}
            </span>
          </div>
          <MonoChip className="mt-1.5 text-[12px]" sample={entry.detail} />
        </div>
      ))}
    </div>
  </div>
);
