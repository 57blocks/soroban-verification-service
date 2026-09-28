import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type CollapsibleSectionProps = {
  title: string;
  count: number | undefined;
  testId: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

export const CollapsibleSection = ({
  title,
  count,
  testId,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-line bg-surface">
      <CollapsibleTrigger
        data-testid={`${testId}-toggle`}
        className="flex w-full select-none items-center gap-2 border-0 bg-transparent px-4 py-3 text-[0.875rem] font-semibold text-ink-value"
      >
        <ChevronDown
          size={14}
          aria-hidden
          className={cn("shrink-0 transition-transform duration-200", open ? "rotate-0" : "-rotate-90")}
        />
        <span>{title}</span>
        <span
          data-testid={`${testId}-badge`}
          className="ml-1 inline-flex min-w-6 items-center justify-center rounded-full bg-surface-alt px-2 py-0.5 font-mono text-[0.7rem] font-medium text-ink-mute"
        >
          {count ?? "…"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-line px-4 py-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};
