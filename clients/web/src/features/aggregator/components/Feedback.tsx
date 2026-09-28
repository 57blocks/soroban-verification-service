import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

export const LoadingRow = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center gap-3" role="status">
    <Loader2 aria-hidden className="size-4 animate-spin text-ink" />
    <span className="text-[0.875rem] text-ink-body">{children}</span>
  </div>
);

export const MutedNote = ({ testId, children }: { testId: string; children: ReactNode }) => (
  <p className="m-0 text-[0.9rem] text-ink-body" data-testid={testId}>
    {children}
  </p>
);
