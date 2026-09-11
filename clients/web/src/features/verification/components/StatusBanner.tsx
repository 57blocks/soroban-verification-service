import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toneBadge, toneGlyph, toneSurface, toneText } from "../constants";
import type { BannerView, ResultTone, SubmissionState } from "../types";
import { CopyableField } from "./CopyableField";
import { MutedLabel } from "./MutedLabel";

type StatusBannerProps = {
  state: SubmissionState;
  meta: { title: string; description: string; tone: ResultTone };
  /** Already resolved by the hook. */
  view: BannerView;
  /** Shown when the API echoes a target without a network. */
  fallbackNetwork: string;
  /** Off where a card elsewhere already names the job — the job page's `CurrentJobBar` does. */
  showJobId?: boolean;
};

/** The headline verdict for the current submission, colour-coded by tone. */
export const StatusBanner = ({
  state,
  meta,
  view,
  fallbackNetwork,
  showJobId = true,
}: StatusBannerProps) => {
  const isRunning = state === "queued";
  const { code, detail, jobId, target } = view;

  return (
    <div
      data-tone={meta.tone}
      className={cn("rounded-lg p-4", toneSurface[meta.tone])}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex-1">
          <h3
            className={cn(
              "m-0 inline-flex items-center gap-2 font-display text-[1.2rem] font-semibold",
              toneText[meta.tone],
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-grid size-[22px] shrink-0 place-items-center rounded-full text-[12px] text-white",
                toneBadge[meta.tone],
              )}
            >
              {/* A rotating text glyph wobbles — its box centre is not its optical centre — so a
                  running job gets a real SVG spinner instead. */}
              {isRunning ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={2.5} />
              ) : (
                toneGlyph[meta.tone]
              )}
            </span>
            {meta.title}
          </h3>

          <p
            className={cn(
              "m-0 ml-[30px] mt-1 max-w-[640px] text-[0.875rem] leading-[1.55] opacity-80",
              toneText[meta.tone],
            )}
          >
            {detail || meta.description}
          </p>

          {code && (
            <p
              className={cn(
                "m-0 ml-[30px] mt-1 font-mono text-xs opacity-70",
                toneText[meta.tone],
              )}
            >
              reason: {code}
            </p>
          )}
        </div>

        {jobId && showJobId && (
          <div className="shrink-0 md:text-right">
            <MutedLabel>Job ID</MutedLabel>
            <div className="mt-0.5 font-mono text-[0.85rem] text-ink">
              {jobId}
            </div>
          </div>
        )}
      </div>

      {target && (
        <div className="mt-4 grid gap-4 rounded-md bg-surface/60 p-4">
          <CopyableField
            label="Network"
            value={target.network || fallbackNetwork}
            copyable={false}
          />
          {target.contract_id && (
            <CopyableField label="Contract ID" value={target.contract_id} mono />
          )}
          {target.wasm_hash && (
            <CopyableField label="Wasm hash" value={target.wasm_hash} mono />
          )}
        </div>
      )}
    </div>
  );
};
