import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { MonoLabel } from "./MonoLabel";

type CurrentJobBarProps = {
  jobId?: string;
  onCopyLink: () => void;
};

/** Header of a job page: which job this is, plus the two ways to leave or share it. */
export const CurrentJobBar = ({ jobId, onCopyLink }: CurrentJobBarProps) => (
  <section className="mb-5 rounded-xl border border-line bg-surface p-4 shadow-panel">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <MonoLabel>Current job</MonoLabel>
        <div className="mt-1 break-all font-mono text-[0.875rem] font-semibold text-ink">
          {jobId || "Loading..."}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="pillSm">
          <Link to="/verify">
            Back to verify console
            <PillIcon size="sm">↩</PillIcon>
          </Link>
        </Button>
        <Button variant="outline" size="pillSm" onClick={onCopyLink}>
          Copy job link
          <PillIcon size="sm">⧉</PillIcon>
        </Button>
      </div>
    </div>
  </section>
);
