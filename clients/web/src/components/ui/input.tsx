import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/** Every input in the design is the same 44px white field: ink border on focus, plus the yellow focus ring. */
export const Input = forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-11 w-full rounded-md border border-line-strong bg-surface px-3 text-[0.875rem] text-ink outline-none transition-shadow",
        "placeholder:text-ink/45",
        "focus:border-ink focus:shadow-focus",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
