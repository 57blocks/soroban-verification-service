import { cn } from "@/lib/utils";

type SegmentedChoiceProps<T extends string> = {
  selected: T;
  options: { value: T; label: string }[];
  onSelect: (value: T) => void;
  className?: string;
};

/**
 * The two-up control the design uses for "Lookup by": a 44px inset track the same height as the select and
 * input beside it, the active half raised out of it on white.
 *
 * The active half was filled with the accent, which made a *selection* the loudest mark on the page while the
 * accent is reserved for a verdict. Nothing here is a verdict, so nothing here is accented.
 */
export const SegmentedChoice = <T extends string>({
  selected,
  options,
  onSelect,
  className,
}: SegmentedChoiceProps<T>) => (
  <div
    className={cn(
      "grid h-11 w-full grid-cols-2 gap-1 rounded-lg border border-line-strong bg-surface-track p-1 text-[0.875rem] font-semibold",
      className,
    )}
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        onClick={() => onSelect(option.value)}
        aria-pressed={selected === option.value}
        className={cn(
          "flex h-[34px] items-center justify-center whitespace-nowrap rounded-md border-0 px-3.5 text-[0.875rem] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow",
          selected === option.value
            ? "bg-surface text-ink shadow-sm"
            : "bg-transparent text-ink/[0.66] hover:bg-surface/60 hover:text-ink",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);
