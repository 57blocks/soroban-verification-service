import { FadeUp } from "@/components/ui/fade-up";
import { trustStripItems } from "../content";

export const TrustStrip = () => (
  <div className="border-b border-line bg-surface px-4 py-[18px] md:px-20">
    <FadeUp>
      <div className="mx-auto flex max-w-shell flex-wrap justify-center gap-x-10 gap-y-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute">
        {trustStripItems.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </FadeUp>
  </div>
);
