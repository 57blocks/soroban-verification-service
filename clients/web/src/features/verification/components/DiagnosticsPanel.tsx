import { useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { copyValue } from "../utils/clipboard.util";
import { diagnosticsText } from "../utils/diagnostics.util";
import { MonoLabel } from "./MonoLabel";

const preClass =
  "m-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-alt p-3 font-mono text-[12px] leading-[1.55] text-ink-value";

type CopyBlockProps = {
  title: string;
  text: string;
  buttonLabel: string;
  preClassName?: string;
};

const CopyBlock = ({
  title,
  text,
  buttonLabel,
  preClassName,
}: CopyBlockProps) => (
  <div>
    <div className="mb-2 flex items-center justify-between gap-3">
      <MonoLabel>{title}</MonoLabel>
      <button
        type="button"
        onClick={() => copyValue(text)}
        className="inline-flex items-center gap-1.5 border-0 bg-transparent px-2 py-1 text-[0.75rem] font-bold text-ink underline decoration-ink/25 underline-offset-[3px] transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
      >
        <Copy size={12} /> {buttonLabel}
      </button>
    </div>
    <pre className={cn(preClass, preClassName)}>{text}</pre>
  </div>
);

type DiagnosticsPanelProps = {
  diagnostics: Record<string, unknown>;
  wasmCompare?: Record<string, unknown>;
  defaultOpen?: boolean;
};

export const DiagnosticsPanel = ({
  diagnostics,
  wasmCompare,
  defaultOpen = false,
}: DiagnosticsPanelProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const [rawOpen, setRawOpen] = useState(false);
  const commandSummary = diagnosticsText(diagnostics, "command_summary");

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-4">
      <CollapsibleTrigger className="flex w-full select-none items-center gap-2 border-0 bg-transparent py-3 text-[0.875rem] font-semibold text-ink-value">
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        Developer diagnostics
        <span className="font-normal text-ink/[0.5]">exact command, raw JSON</span>
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t border-line-strong pt-3.5">
        <div className="space-y-4">
          {commandSummary && (
            <CopyBlock
              title="Command summary"
              text={commandSummary}
              buttonLabel="Copy"
            />
          )}

          {wasmCompare && (
            <CopyBlock
              title="Wasm comparison JSON"
              text={JSON.stringify(wasmCompare, null, 2)}
              buttonLabel="Copy JSON"
              preClassName="max-h-[260px]"
            />
          )}

          <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
            <CollapsibleTrigger className="flex w-full select-none items-center gap-1.5 border-0 bg-transparent py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute transition-colors hover:text-ink">
              <ChevronDown
                size={12}
                aria-hidden
                className={cn(
                  "shrink-0 transition-transform duration-200",
                  rawOpen ? "rotate-0" : "-rotate-90",
                )}
              />
              Raw diagnostics
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-2">
                <CopyBlock
                  title="Everything the sandbox reported"
                  text={JSON.stringify(diagnostics, null, 2)}
                  buttonLabel="Copy JSON"
                  preClassName="max-h-[280px]"
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
