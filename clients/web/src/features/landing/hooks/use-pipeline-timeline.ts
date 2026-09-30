import { type RefObject, useEffect, useRef } from "react";
import {
  buildStackedTimeline,
  buildWideTimeline,
  restoreScramble,
  type PipelineTimeline,
} from "../utils/pipeline-timeline.util";

const MOTION_OK = "(prefers-reduced-motion: no-preference)";
const WIDE = `(min-width: 1180px) and ${MOTION_OK}`;
const STACKED = `(max-width: 1179.98px) and ${MOTION_OK}`;

export const usePipelineTimeline = (
  root: RefObject<HTMLElement | null>,
  inView: boolean,
) => {
  const timeline = useRef<PipelineTimeline | null>(null);
  const visible = useRef(inView);

  useEffect(() => {
    visible.current = inView;
    timeline.current?.paused(!inView);
  }, [inView]);

  useEffect(() => {
    const node = root.current;
    if (!node || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia(MOTION_OK).matches) return;

    let cancelled = false;
    let revert: (() => void) | undefined;

    import("gsap")
      .then(({ gsap }) => {
        if (cancelled) return;
        const mm = gsap.matchMedia(node);
        mm.add({ wide: WIDE, stacked: STACKED }, (context) => {
          const build = context.conditions?.wide
            ? buildWideTimeline
            : buildStackedTimeline;
          const tl = build(gsap, node);
          tl.paused(!visible.current);
          timeline.current = tl;
          return () => {
            timeline.current = null;
            restoreScramble(node);
          };
        });
        revert = () => mm.revert();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      revert?.();
    };
  }, [root]);
};
