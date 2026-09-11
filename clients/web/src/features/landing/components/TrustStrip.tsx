import { FadeUp } from "@/components/ui/fade-up";
import { trustStripItems } from "../content";

/** The thin monospace band of feature claims directly under the hero. */
export const TrustStrip = () => (
  <div className="border-b border-line bg-surface px-8 py-[22px]">
    <FadeUp>
      <div className="mx-auto flex max-w-shell flex-wrap gap-x-14 gap-y-3 font-mono text-[0.78rem] uppercase tracking-[0.12em] text-ink-mute">
        {trustStripItems.map((item) => (
          <span key={item} className="inline-flex items-center gap-2.5">
            <span
              aria-hidden
              className="text-yellow [text-shadow:0_0_1px_theme(colors.yellow.shade)]"
            >
              ◆
            </span>
            {item}
          </span>
        ))}
      </div>
    </FadeUp>
  </div>
);
