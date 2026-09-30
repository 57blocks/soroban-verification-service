import type { gsap } from "gsap";
import { maskHex, scrambleFrame } from "./hash-scramble.util";

export type Gsap = typeof gsap;
export type PipelineTimeline = ReturnType<Gsap["timeline"]>;

const DIM = 0.35;
const HOLD = 2.5;
const FADE = 0.4;
const VERDICT_LENGTH = 0.75;

// Must match yellow.DEFAULT and yellow.pale in tailwind.config.js; GSAP cannot read Tailwind tokens.
const RING_ON = "0 0 0 4px rgba(245, 211, 90, 0.6)";
const RING_OFF = "0 0 0 0px rgba(245, 211, 90, 0)";
const FLASH_BG = "#fdf6dd";

const hook = (name: string) => `[data-tl="${name}"]`;
const hooks = (prefix: string, names: string[]) =>
  names.map((name) => hook(`${prefix}-${name}`)).join(",");

const scrambleSpans = (root: ParentNode, selector = "") => [
  ...root.querySelectorAll<HTMLElement>(`${selector} [data-scramble]`.trim()),
];

export const restoreScramble = (root: HTMLElement) => {
  for (const span of scrambleSpans(root)) {
    span.textContent = span.dataset.scramble ?? "";
  }
};

const maskAll = (root: HTMLElement) => {
  for (const span of scrambleSpans(root)) {
    span.textContent = maskHex(span.dataset.scramble ?? "");
  }
};

interface Stage {
  tl: PipelineTimeline;
  root: HTMLElement;
  prefix: string;
  dimmed: string;
}

const stage = (
  gsap: Gsap,
  root: HTMLElement,
  prefix: string,
  dimmedNames: string[],
  dotNames: string[],
): Stage => {
  const tl = gsap.timeline({ repeat: -1 });
  const dimmed = hooks(prefix, dimmedNames);
  tl.set(dimmed, { opacity: DIM, boxShadow: RING_OFF }, 0)
    .set(hooks(prefix, dotNames), { opacity: 0, x: 0, y: 0 }, 0)
    .set(hook(`${prefix}-verdict`), { opacity: 0, scale: 0.6 }, 0)
    .set(hooks(prefix, ["verdict-note", "published"]), { opacity: 0 }, 0)
    .call(maskAll, [root], 0);
  return { tl, root, prefix, dimmed };
};

const at = (s: Stage, name: string) => hook(`${s.prefix}-${name}`);

const light = (s: Stage, name: string, position: number) => {
  s.tl.to(at(s, name), { opacity: 1, duration: 0.3 }, position);
};

const travel = (
  s: Stage,
  name: string,
  axis: "x" | "y",
  distance: number,
  position: number,
) => {
  s.tl
    .fromTo(
      at(s, name),
      { [axis]: 0, opacity: 1 },
      { [axis]: distance, duration: 0.5, ease: "none", immediateRender: false },
      position,
    )
    .to(at(s, name), { opacity: 0, duration: 0.1 }, position + 0.4);
};

const pulse = (s: Stage, name: string, position: number) => {
  s.tl.to(
    at(s, name),
    {
      boxShadow: RING_ON,
      duration: 0.25,
      yoyo: true,
      repeat: 3,
      ease: "sine.inOut",
    },
    position,
  );
};

const scramble = (s: Stage, name: string, position: number) => {
  for (const span of scrambleSpans(s.root, at(s, name))) {
    const digest = span.dataset.scramble ?? "";
    const state = { progress: 0 };
    s.tl.to(
      state,
      {
        progress: 1,
        duration: 0.6,
        ease: "none",
        onUpdate: () => {
          span.textContent = scrambleFrame(digest, state.progress);
        },
      },
      position,
    );
  }
};

const flash = (s: Stage, names: string[], position: number) => {
  s.tl.to(
    hooks(s.prefix, names),
    {
      boxShadow: RING_ON,
      backgroundColor: FLASH_BG,
      duration: 0.2,
      yoyo: true,
      repeat: 1,
      ease: "sine.inOut",
    },
    position,
  );
};

const verdict = (s: Stage, position: number) => {
  s.tl
    .to(
      at(s, "verdict"),
      { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(1.7)" },
      position,
    )
    .to(at(s, "verdict-note"), { opacity: 1, duration: 0.25 }, position + 0.3)
    .to(at(s, "published"), { opacity: 1, duration: 0.25 }, position + 0.5);
};

const fadeBack = (s: Stage, position: number) => {
  s.tl
    .to(s.dimmed, { opacity: DIM, duration: FADE }, position)
    .to(at(s, "verdict"), { opacity: 0, scale: 0.6, duration: FADE }, position)
    .to(
      hooks(s.prefix, ["verdict-note", "published"]),
      { opacity: 0, duration: FADE },
      position,
    )
    .call(maskAll, [s.root], position + FADE);
};

export const buildWideTimeline = (gsap: Gsap, root: HTMLElement) => {
  const s = stage(
    gsap,
    root,
    "w",
    ["source", "seal", "rebuilt", "contract", "deployed", "onchain"],
    ["dot-1", "dot-2", "dot-3", "dot-4", "merge-a", "merge-b"],
  );
  const merges = hooks("w", ["merge-a", "merge-b"]);
  s.tl.set(merges, { offsetDistance: "0%" }, 0);

  light(s, "source", 0);
  travel(s, "dot-1", "x", 26, 0.3);
  light(s, "contract", 0.4);
  travel(s, "dot-3", "x", 26, 0.7);
  light(s, "seal", 0.8);
  pulse(s, "seal", 0.8);
  light(s, "deployed", 1.2);
  travel(s, "dot-4", "x", 26, 1.2);
  light(s, "onchain", 1.7);
  scramble(s, "onchain", 1.7);
  travel(s, "dot-2", "x", 26, 1.8);
  light(s, "rebuilt", 2.3);
  scramble(s, "rebuilt", 2.3);
  s.tl
    .to(merges, { opacity: 1, duration: 0.1 }, 2.9)
    .to(
      merges,
      { offsetDistance: "100%", duration: 0.6, ease: "power1.inOut" },
      2.9,
    )
    .to(merges, { opacity: 0, duration: 0.1 }, 3.4);
  flash(s, ["rebuilt", "onchain"], 3.5);
  verdict(s, 3.9);
  fadeBack(s, 3.9 + VERDICT_LENGTH + HOLD);
  return s.tl;
};

export const buildStackedTimeline = (gsap: Gsap, root: HTMLElement) => {
  const s = stage(
    gsap,
    root,
    "s",
    ["source", "seal", "rebuilt", "onchain"],
    ["dot-1", "dot-2", "dot-3", "dot-4"],
  );

  light(s, "source", 0);
  travel(s, "dot-1", "y", 13, 0.3);
  light(s, "seal", 0.8);
  pulse(s, "seal", 0.8);
  travel(s, "dot-2", "y", 13, 1.8);
  light(s, "rebuilt", 2.3);
  scramble(s, "rebuilt", 2.3);
  travel(s, "dot-3", "y", 13, 2.9);
  light(s, "onchain", 3.4);
  scramble(s, "onchain", 3.4);
  travel(s, "dot-4", "y", 13, 4.0);
  flash(s, ["rebuilt", "onchain"], 4.5);
  verdict(s, 4.9);
  fadeBack(s, 4.9 + VERDICT_LENGTH + HOLD);
  return s.tl;
};
