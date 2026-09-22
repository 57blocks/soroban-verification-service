import { SealedBox } from "@/components/sealed-box";
import { pipelineSample } from "../content";

/**
 * The hero's diagram: the two lanes the service holds against each other — the source it rebuilt, and the
 * bytes already on chain — converging on one comparison that happens outside the sandbox.
 *
 * The sample values are illustrative and say so in `content/pipeline.ts`; nothing here is fetched.
 */

const laneCardClass =
  "rounded-xl border border-line bg-surface px-[18px] py-3.5 text-left font-mono text-[13px] text-ink";

const hashChipClass =
  "rounded-lg border border-line bg-surface-alt px-3.5 py-2.5 font-mono text-[13px] text-ink";

/** A horizontal connector with one accent dot travelling along it. */
const Connector = ({ delay }: { delay: number }) => (
  <svg width="36" height="12" viewBox="0 0 36 12" aria-hidden className="shrink-0">
    <line x1="0" y1="6" x2="28" y2="6" stroke="currentColor" strokeWidth="1" className="text-ink-mute" />
    <path d="M28 2 L35 6 L28 10 Z" fill="currentColor" className="text-ink-mute" />
    <circle
      cx="3"
      cy="6"
      r="2.5"
      className="fill-yellow-deep motion-safe:animate-flow-x"
      style={{ animationDelay: `${delay}ms` }}
    />
  </svg>
);

/** The vertical connector the mobile stack uses. */
const ConnectorDown = ({ delay }: { delay: number }) => (
  <svg width="12" height="22" viewBox="0 0 12 22" aria-hidden>
    <line x1="6" y1="0" x2="6" y2="15" stroke="currentColor" strokeWidth="1" className="text-ink-mute" />
    <path d="M2 14 L6 21 L10 14 Z" fill="currentColor" className="text-ink-mute" />
    <circle
      cx="6"
      cy="3"
      r="2"
      className="fill-yellow-deep motion-safe:animate-flow-y"
      style={{ animationDelay: `${delay}ms` }}
    />
  </svg>
);

/** The rebuild lane's sealed box, with this diagram's own rim label and content. */
const RebuildSeal = ({ className }: { className?: string }) => (
  <SealedBox label={pipelineSample.seal} {...(className ? { className } : {})}>
    <span className="font-mono text-[13px] text-ink">{pipelineSample.rebuild}</span>
  </SealedBox>
);

/** The verdict the two lanes meet at. */
const Verdict = () => (
  <div className="flex flex-col items-center gap-2.5">
    <span className="grid size-[76px] place-items-center rounded-full bg-yellow font-mono text-[13px] font-medium text-ink">
      {pipelineSample.verdict}
    </span>
    <span className="max-w-[130px] font-mono text-[10px] leading-relaxed text-ink-mute">
      {pipelineSample.verdictNote}
    </span>
    <span className="font-mono text-xs font-medium text-success-fg">{pipelineSample.published}</span>
  </div>
);

export const RebuildPipeline = () => (
  <div className="mt-12 md:mt-[72px]">
    {/* Wide: two lanes side by side, joined by a curve into the verdict. */}
    <div className="mx-auto hidden items-center justify-center min-[1180px]:flex">
      <div className="flex min-w-0 flex-col gap-11">
        <div className="flex items-center justify-end gap-3.5">
          <div className={laneCardClass}>
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
              {pipelineSample.sourceLabel}
            </span>
            <span className="mt-1 block">{pipelineSample.source}</span>
          </div>
          <Connector delay={0} />
          <RebuildSeal />
          <Connector delay={500} />
          <span className={hashChipClass}>{pipelineSample.rebuiltHash}</span>
        </div>

        <div className="flex items-center justify-end gap-3.5">
          <div className={laneCardClass}>
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-ink-mute">
              {pipelineSample.chainLabel}
            </span>
            <span className="mt-1 block">{pipelineSample.contract}</span>
          </div>
          <Connector delay={250} />
          <span className={laneCardClass}>{pipelineSample.deployed}</span>
          <Connector delay={750} />
          <span className={hashChipClass}>{pipelineSample.deployedHash}</span>
        </div>
      </div>

      {/* The join. `offset-path` is what moves the two dots along the curves; where it is unsupported the
          dots stay at the path's origin, which is why they are `r=0` until the animation runs. */}
      <svg width="72" height="160" viewBox="0 0 72 160" aria-hidden className="text-ink-mute">
        <path d="M0 36 C36 36 36 80 64 80" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M0 124 C36 124 36 80 64 80" fill="none" stroke="currentColor" strokeWidth="1" />
        <circle
          r="2.5"
          className="fill-yellow-deep motion-safe:animate-flow-path"
          style={{ offsetPath: "path('M0 36 C36 36 36 80 64 80')", animationDelay: "1000ms" }}
        />
        <circle
          r="2.5"
          className="fill-yellow-deep motion-safe:animate-flow-path"
          style={{ offsetPath: "path('M0 124 C36 124 36 80 64 80')", animationDelay: "1250ms" }}
        />
      </svg>

      <Verdict />
    </div>

    {/* Narrow: the same six steps, stacked. */}
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 min-[1180px]:hidden">
      <div className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left font-mono text-[11px] text-ink">
        <span className="text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          {pipelineSample.sourceLabel}
        </span>{" "}
        {pipelineSample.source}
      </div>
      <ConnectorDown delay={0} />
      <RebuildSeal className="w-full" />
      <ConnectorDown delay={250} />
      <div className="w-full rounded-lg border border-line bg-surface-alt px-3.5 py-2.5 text-left font-mono text-[11px] text-ink">
        {pipelineSample.rebuiltHash}
      </div>
      <ConnectorDown delay={500} />
      <div className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left font-mono text-[11px] text-ink">
        <span className="text-[9px] uppercase tracking-[0.1em] text-ink-mute">
          {pipelineSample.chainLabel}
        </span>{" "}
        {pipelineSample.deployedHash}
      </div>
      <ConnectorDown delay={750} />
      <Verdict />
    </div>
  </div>
);
