import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

/** The one in-progress affordance these pages use, so a change reaches all of them. */
export const LoadingRow = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center gap-3" role="status">
    <Loader2 aria-hidden className="size-4 animate-spin text-ink" />
    <span className="text-[0.875rem] text-ink-muted">{children}</span>
  </div>
);

/** A muted line of prose the reader is meant to act on. `testId` is load-bearing for the suite. */
export const MutedNote = ({ testId, children }: { testId: string; children: ReactNode }) => (
  <p className="m-0 text-[0.9rem] text-ink-muted" data-testid={testId}>
    {children}
  </p>
);
