import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldShellProps = {
  label: ReactNode;
  /** The short line the design sets to the right of the label. */
  hint?: ReactNode;
  /** Longer help under the input. Rendered red when the field is required or has an error. */
  help?: ReactNode;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
};

/** The one field layout used by every input in the console: label row, control, help line. */
export const FieldShell = ({
  label,
  hint,
  help,
  error,
  required = false,
  htmlFor,
  children,
}: FieldShellProps) => {
  const message = error || help;

  return (
    <div>
      <div
        className={cn(
          "mb-2 flex flex-wrap gap-x-4 gap-y-1",
          hint ? "items-baseline justify-between" : "items-baseline",
        )}
      >
        <Label htmlFor={htmlFor}>
          {label}
          {required && <span className="text-danger-mark"> *</span>}
        </Label>
        {hint && (
          <span className="text-[0.75rem] leading-[1.45] text-ink/[0.66]">
            {hint}
          </span>
        )}
      </div>

      {children}

      {message && (
        <p
          className={cn(
            "mt-2 text-[0.75rem] leading-[1.45]",
            error || required ? "text-danger-fg" : "text-ink/[0.66]",
          )}
        >
          {message}
        </p>
      )}
    </div>
  );
};
