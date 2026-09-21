import { Link } from "@tanstack/react-router";
import { ArrowLeft, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MutedLabel } from "./MutedLabel";

type CurrentJobBarProps = {
  jobId?: string;
  onCopyLink: () => void;
};

/** Header of a job page: which job this is, plus the two ways to leave or share it. */
export const CurrentJobBar = ({ jobId, onCopyLink }: CurrentJobBarProps) => (
  <section className="mb-5 rounded-xl border border-line bg-surface p-4 shadow-panel">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <MutedLabel>Current job</MutedLabel>
        <div className="mt-1 break-all font-mono text-[0.875rem] font-semibold text-ink">
          {jobId || "Loading..."}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/verify">
            Back to verify console
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <Button variant="outline" size="sm" onClick={onCopyLink}>
          Copy job link
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  </section>
);
