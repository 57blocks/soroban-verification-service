import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toneBadge, toneGlyph, toneSurface, toneText } from "../constants";
import type { BannerView, ResultTone, SubmissionState } from "../types";
import { CopyableField } from "./CopyableField";
import { MonoLabel } from "./MonoLabel";

type StatusBannerProps = {
  state: SubmissionState;
  meta: { title: string; description: string; tone: ResultTone };
  view: BannerView;
  fallbackNetwork: string;
  showJobId?: boolean;
};

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
              "m-0 inline-flex items-center gap-2 text-[1.2rem] font-semibold",
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
            <MonoLabel>Job ID</MonoLabel>
            <div className="mt-1 font-mono text-[0.8rem] text-ink">{jobId}</div>
          </div>
        )}
      </div>

      {target && (
        <div className="mt-4 grid gap-4 rounded-lg bg-surface/70 p-4">
          <CopyableField
            label="Network"
            value={target.network || fallbackNetwork}
            copyable={false}
          />
          {target.contract_id && (
            <CopyableField label="Contract ID" value={target.contract_id} />
          )}
          {target.wasm_hash && (
            <CopyableField label="Wasm hash" value={target.wasm_hash} />
          )}
        </div>
      )}
    </div>
  );
};
