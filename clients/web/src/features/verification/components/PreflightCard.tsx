import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { preflightBlockedCopy, toneBadge, toneGlyph, toneSurface, toneText } from "../constants";
import type { PreflightState, ResultTone } from "../types";
import { MonoLabel } from "./MonoLabel";

type PreflightCardProps = {
  state: PreflightState;
};

export const PreflightCard = ({ state }: PreflightCardProps) => {
  if (state.phase === "idle") return null;

  if (state.phase === "running") {
    return (
      <div className="mt-8 flex items-center gap-3 rounded-xl border border-line bg-surface p-5 shadow-panel">
        <Loader2 aria-hidden className="size-4 animate-spin text-ink" />
        <span className="text-[0.875rem] font-medium text-ink-value">
          Checking whether this contract can be verified...
        </span>
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <Banner
        tone="warning"
        title="Could not check this contract"
        description={state.error}
        note="This is a problem reaching the verifier, not a verdict about your contract."
      />
    );
  }

  const { verdict, response } = state;

  if (verdict.gate === "ready") {
    return (
      <Banner
        tone="success"
        title="This contract can be verified"
        description={
          verdict.kind === "chain_named"
            ? "Its deployed Wasm names a build image this verifier accepts. Provide the source below and the rebuild will use that image."
            : "Its deployed Wasm records a toolchain pair this verifier can compose an environment for. Provide the source below."
        }
        note={`Deployed Wasm hash ${response.wasm_hash}`}
      />
    );
  }

  const copy = preflightBlockedCopy[verdict.label === "unrecognized" ? "unrecognized" : verdict.reason];

  return (
    <Banner
      tone="danger"
      title={copy.title}
      description={copy.description}
      note={verdict.label === "unrecognized" ? undefined : `Reported as ${verdict.label}`}
      detail={verdict.gate === "blocked" && verdict.label === "policy_rejected" ? verdict.detail : undefined}
    />
  );
};

type BannerProps = {
  tone: ResultTone;
  title: string;
  description: string;
  note?: string;
  detail?: string;
};

const Banner = ({ tone, title, description, note, detail }: BannerProps) => (
  <div data-tone={tone} data-testid="preflight-card" className={cn("mt-8 rounded-lg p-4", toneSurface[tone])}>
    <h3
      className={cn(
        "m-0 inline-flex items-center gap-2 text-[1.2rem] font-semibold",
        toneText[tone],
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-grid size-[22px] shrink-0 place-items-center rounded-full text-[12px] text-white",
          toneBadge[tone],
        )}
      >
        {toneGlyph[tone]}
      </span>
      {title}
    </h3>
    <p className="mb-0 mt-2 text-[0.9rem] leading-relaxed text-ink-body">{description}</p>
    {detail && <p className="mb-0 mt-2 break-words text-[0.85rem] text-ink-body">{detail}</p>}
    {note && (
      <div className="mt-3">
        <MonoLabel>{note}</MonoLabel>
      </div>
    )}
  </div>
);
