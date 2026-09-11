import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { BuildLogUnavailableResponse } from "@scvs/verify-api-client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { BuildLogState } from "../types";
import { foldBuildLog, foldedLineCount, type LogSegment } from "../utils/build-log.util";
import { CopyableField } from "./CopyableField";
import { MutedLabel } from "./MutedLabel";

type BuildLogPanelProps = {
  state: BuildLogState;
  /**
   * This browser's token for this job, when it holds one. Shown so the submitter can move it to another
   * device or send it to a colleague deliberately — the Service cannot re-issue it, and a token nobody can
   * see is a token nobody can use twice (build-log-access design.md §4).
   */
  token?: string;
};

const logTextClass =
  "m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[0.8rem] leading-relaxed text-ink-value";

/** One folded run of bookkeeping, expanding in place to the exact lines it stands for. */
const FoldedRun = ({ label, text, lineCount }: { label: string; text: string; lineCount: number }) => {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded border-0 bg-transparent px-1 py-1 text-left text-[0.75rem] text-ink/[0.6] transition-colors",
          "hover:bg-yellow-soft/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow",
        )}
      >
        {open ? (
          <ChevronDown size={12} aria-hidden className="shrink-0" />
        ) : (
          <ChevronRight size={12} aria-hidden className="shrink-0" />
        )}
        <span className="font-sans">{label}</span>
        <span className="text-ink/40">· {lineCount} lines</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className={cn(logTextClass, "mt-1 border-l-2 border-line-strong pl-3 text-ink/[0.62]")}>
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
};

const LogBody = ({ segments }: { segments: LogSegment[] }) => (
  <div className="max-h-[28rem] space-y-1 overflow-auto rounded bg-surface-alt p-4">
    {segments.map((segment, index) =>
      segment.kind === "folded" ? (
        <FoldedRun
          key={`fold-${index}`}
          label={segment.label}
          text={segment.text}
          lineCount={segment.lineCount}
        />
      ) : (
        // `<pre>{text}</pre>` — the log is the sandbox's output, which is the untrusted side of the trust
        // boundary.
        <pre key={`text-${index}`} className={logTextClass}>
          {segment.text}
        </pre>
      ),
    )}
  </div>
);

/**
 * The full redacted build output for a terminal job (UI2), and — just as importantly — what to say when there
 * is none.
 */
export const BuildLogPanel = ({ state, token }: BuildLogPanelProps) => {
  const [open, setOpen] = useState(false);
  if (state.phase === "idle") return null;

  const segments = state.phase === "log" ? foldBuildLog(state.text) : [];
  const hidden = foldedLineCount(segments);

  if (state.phase !== "log") {
    return (
      <section
        data-testid="build-log"
        className="overflow-hidden rounded-lg bg-surface p-6 shadow-panel"
      >
        <h3 className="m-0 font-display text-[1.2rem] font-semibold">Build log</h3>
        <div className="mt-4">{renderBody(state, segments)}</div>
      </section>
    );
  }

  return (
    <section
      data-testid="build-log"
      className="overflow-hidden rounded-lg bg-surface px-6 shadow-panel"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full select-none items-center gap-2 border-0 bg-transparent py-5 text-left">
          <ChevronDown
            size={16}
            aria-hidden
            className={cn(
              "shrink-0 transition-transform duration-200",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
          <h3 className="m-0 font-display text-[1.2rem] font-semibold">Build log</h3>
          {hidden > 0 && (
            <span className="text-[0.75rem] text-ink/[0.55]">
              {hidden.toLocaleString()} routine lines folded
            </span>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="pb-6">
            {renderBody(state, segments)}
            {token && <LogToken token={token} />}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
};

/**
 * Shown only where the log itself is shown, and only to a browser that already holds the token — it
 * reveals nothing a reader of this page could not already do, and is the sole way to carry the token
 * anywhere else.
 */
const LogToken = ({ token }: { token: string }) => (
  <div className="mt-4 rounded-md bg-surface-alt p-4">
    <CopyableField label="Build-log token (keep it: this Service cannot re-issue it)" value={token} mono />
  </div>
);

const renderBody = (state: BuildLogState, segments: LogSegment[]) => {
  switch (state.phase) {
    case "loading":
      return (
        <div className="flex items-center gap-3">
          <Loader2 aria-hidden className="size-4 animate-spin text-ink" />
          <span className="text-[0.875rem] text-ink-muted">Loading the build log...</span>
        </div>
      );

    case "log":
      return (
        <div data-testid="build-log-text">
          <LogBody segments={segments} />
        </div>
      );

    case "empty":
      return (
        <p className="m-0 text-[0.9rem] text-ink-muted">
          The build ran and produced no output. There is nothing to show, which is itself unusual —
          if this job failed, the reason is on the result above rather than here.
        </p>
      );

    case "unavailable":
      return <Unavailable body={state.body} />;

    // The shared-link case, and the designed one: the raw log answers to a token the submitter received,
    // not to the job id in this URL (build-log-access design.md BL-1, §4).
    case "needs-token":
      return (
        <p className="m-0 text-[0.9rem] text-ink-muted">
          The raw build log is not part of this page. It answers to a one-time token that was shown to
          whoever submitted this job, in this browser &mdash; not to the job link, which anyone may hold.
          The verdict and the diagnostics above are the whole public record; ask the submitter if you need
          the compiler output itself.
        </p>
      );

    case "expired":
      return (
        <p className="m-0 text-[0.9rem] text-ink-muted">
          The raw build log has passed its retention period and been deleted. Compiler output can carry
          source, paths and credentials, so it is not kept indefinitely. Everything above is unaffected and
          is permanent.
        </p>
      );

    case "unreadable":
      return (
        <p className="m-0 text-[0.9rem] text-ink-muted">
          This job&apos;s build log could not be read. That is different from there not being one —
          the reference exists, but fetching it failed. Retry shortly; if it persists it is a
          verifier-side problem, not a problem with your submission.
        </p>
      );

    default:
      return null;
  }
};

const Unavailable = ({ body }: { body: BuildLogUnavailableResponse }) => (
  <div>
    <p className="m-0 text-[0.9rem] text-ink-muted">
      No build was started for this job, so there is no log. What follows is why it was not
      attempted — not an error fetching it.
    </p>
    <div className="mt-3 space-y-1">
      {body.job_status && <MutedLabel>Job status: {body.job_status}</MutedLabel>}
      {body.failure_reason && <MutedLabel>Reason: {body.failure_reason}</MutedLabel>}
      {!body.job_status && !body.failure_reason && body.message && (
        <MutedLabel>{body.message}</MutedLabel>
      )}
    </div>
  </div>
);
