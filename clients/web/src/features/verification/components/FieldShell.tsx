import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldShellProps = {
  label: ReactNode;
  hint?: ReactNode;
  help?: ReactNode;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
};

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
