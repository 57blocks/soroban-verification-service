import { SealedBox } from "@/components/sealed-box";
import { useInView } from "@/lib/use-in-view";
import { pipelineSample } from "../content";
import { usePipelineTimeline } from "../hooks/use-pipeline-timeline";

const laneCardClass =
  "rounded-xl border border-line bg-surface px-[18px] py-3.5 text-left font-mono text-[13px] text-ink";

const hashChipClass =
  "rounded-lg border border-line bg-surface-alt px-3.5 py-2.5 font-mono text-[13px] text-ink";

const HashText = ({ value }: { value: string }) => {
  const split = value.indexOf(" ") + 1;
  const digest = value.slice(split);

  return (
    <>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">
        {value.slice(0, split)}
        <span data-scramble={digest}>{digest}</span>
      </span>
    </>
  );
};

const Connector = ({ dot }: { dot: string }) => (
  <svg width="36" height="12" viewBox="0 0 36 12" aria-hidden className="shrink-0">
    <line x1="0" y1="6" x2="28" y2="6" stroke="currentColor" strokeWidth="1" className="text-ink-mute" />
    <path d="M28 2 L35 6 L28 10 Z" fill="currentColor" className="text-ink-mute" />
    <circle data-tl={dot} cx="3" cy="6" r="2.5" className="fill-yellow-deep" />
  </svg>
);

const ConnectorDown = ({ dot }: { dot: string }) => (
  <svg width="12" height="22" viewBox="0 0 12 22" aria-hidden>
    <line x1="6" y1="0" x2="6" y2="15" stroke="currentColor" strokeWidth="1" className="text-ink-mute" />
    <path d="M2 14 L6 21 L10 14 Z" fill="currentColor" className="text-ink-mute" />
    <circle data-tl={dot} cx="6" cy="3" r="2" className="fill-yellow-deep" />
  </svg>
);

const RebuildSeal = ({ tl, className }: { tl: string; className?: string }) => (
  <SealedBox label={pipelineSample.seal} data-tl={tl} {...(className ? { className } : {})}>
    <span className="font-mono text-[13px] text-ink">{pipelineSample.rebuild}</span>
  </SealedBox>
);

const Verdict = ({ prefix }: { prefix: string }) => (
  <div className="flex flex-col items-center gap-2.5">
    <span
      data-tl={`${prefix}-verdict`}
      className="grid size-[76px] place-items-center rounded-full bg-yellow font-mono text-[13px] font-medium text-ink"
    >
      {pipelineSample.verdict}
    </span>
    <span
      data-tl={`${prefix}-verdict-note`}
      className="max-w-[130px] font-mono text-[10px] leading-relaxed text-ink-mute"
    >
      {pipelineSample.verdictNote}
    </span>
    <span data-tl={`${prefix}-published`} className="font-mono text-xs font-medium text-success-fg">
      {pipelineSample.published}
    </span>
  </div>
);

export const RebuildPipeline = () => {
  const { ref, inView } = useInView<HTMLDivElement>({ triggerOnce: false, rootMargin: "0px" });
  usePipelineTimeline(ref, inView);

  return (
    <div ref={ref} className="mt-12 md:mt-[72px]">
      <div className="mx-auto hidden items-center justify-center min-[1180px]:flex">
        <div className="flex min-w-0 flex-col gap-11">
          <div className="flex items-center justify-end gap-3.5">
            <div data-tl="w-source" className={laneCardClass}>
              <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                {pipelineSample.sourceLabel}
              </span>
              <span className="mt-1 block">{pipelineSample.source}</span>
            </div>
            <Connector dot="w-dot-1" />
            <RebuildSeal tl="w-seal" />
            <Connector dot="w-dot-2" />
            <span data-tl="w-rebuilt" className={hashChipClass}>
              <HashText value={pipelineSample.rebuiltHash} />
            </span>
          </div>

          <div className="flex items-center justify-end gap-3.5">
            <div data-tl="w-contract" className={laneCardClass}>
              <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
                {pipelineSample.chainLabel}
              </span>
              <span className="mt-1 block">{pipelineSample.contract}</span>
            </div>
            <Connector dot="w-dot-3" />
            <span data-tl="w-deployed" className={laneCardClass}>
              {pipelineSample.deployed}
            </span>
            <Connector dot="w-dot-4" />
            <span data-tl="w-onchain" className={hashChipClass}>
              <HashText value={pipelineSample.deployedHash} />
            </span>
          </div>
        </div>

        <svg width="72" height="160" viewBox="0 0 72 160" aria-hidden className="text-ink-mute">
          <path d="M0 36 C36 36 36 80 64 80" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M0 124 C36 124 36 80 64 80" fill="none" stroke="currentColor" strokeWidth="1" />
          <circle
            data-tl="w-merge-a"
            r="2.5"
            className="fill-yellow-deep"
            style={{ offsetPath: "path('M0 36 C36 36 36 80 64 80')" }}
          />
          <circle
            data-tl="w-merge-b"
            r="2.5"
            className="fill-yellow-deep"
            style={{ offsetPath: "path('M0 124 C36 124 36 80 64 80')" }}
          />
        </svg>

        <Verdict prefix="w" />
      </div>

      <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 min-[1180px]:hidden">
        <div
          data-tl="s-source"
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left font-mono text-[11px] text-ink"
        >
          <span className="text-[9px] uppercase tracking-[0.1em] text-ink-mute">
            {pipelineSample.sourceLabel}
          </span>{" "}
          {pipelineSample.source}
        </div>
        <ConnectorDown dot="s-dot-1" />
        <RebuildSeal tl="s-seal" className="w-full" />
        <ConnectorDown dot="s-dot-2" />
        <div
          data-tl="s-rebuilt"
          className="w-full rounded-lg border border-line bg-surface-alt px-3.5 py-2.5 text-left font-mono text-[11px] text-ink"
        >
          <HashText value={pipelineSample.rebuiltHash} />
        </div>
        <ConnectorDown dot="s-dot-3" />
        <div
          data-tl="s-onchain"
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left font-mono text-[11px] text-ink"
        >
          <span className="text-[9px] uppercase tracking-[0.1em] text-ink-mute">
            {pipelineSample.chainLabel}
          </span>{" "}
          <HashText value={pipelineSample.deployedHash} />
        </div>
        <ConnectorDown dot="s-dot-4" />
        <Verdict prefix="s" />
      </div>
    </div>
  );
};
