import { useEffect, useState, type FC, type ReactNode } from "react";

/**
 * Swaps between words with a per-character wave: the current word's characters slide up and fade out
 * last-to-first, and only once they are gone does the next word's characters rise into place first-to-last.
 */

interface RotatingTextProps {
  words: string[];
  /** Milliseconds a word rests, fully visible, before it starts leaving (default 2000). */
  intervalMs?: number;
  /** Per-character stagger delay in ms (default 45). */
  staggerMs?: number;
  className?: string;
}

/** Durations of one character's animations. Must match the CSS animation tokens. */
const ENTER_MS = 500;
const EXIT_MS = 400;

/** How long a whole word takes to finish its wave, stagger included. */
const waveMs = (word: string, staggerMs: number, charMs: number) =>
  Math.max(word.length - 1, 0) * staggerMs + charMs;

export const RotatingText: FC<RotatingTextProps> = ({
  words,
  intervalMs = 2000,
  staggerMs = 45,
  className,
}) => {
  // `phase` is which half of the swap is playing; `cycle` re-keys the character spans so a fresh mount restarts
  // their CSS animations.
  const [{ index, phase, cycle }, setState] = useState({
    index: 0,
    phase: "in" as "in" | "out",
    cycle: 0,
  });

  useEffect(() => {
    if (words.length < 2) return;
    const word = words[index];

    // One timeout per phase, so the cleanup always cancels the whole chain.
    const timer =
      phase === "in"
        ? setTimeout(
            () => setState((s) => ({ ...s, phase: "out", cycle: s.cycle + 1 })),
            waveMs(word, staggerMs, ENTER_MS) + intervalMs,
          )
        : setTimeout(
            () =>
              setState((s) => ({
                index: (s.index + 1) % words.length,
                phase: "in",
                cycle: s.cycle + 1,
              })),
            waveMs(word, staggerMs, EXIT_MS),
          );

    return () => clearTimeout(timer);
  }, [words, index, phase, intervalMs, staggerMs]);

  return (
    <span className={`rotating-text${className ? ` ${className}` : ""}`}>
      {/* One span per character reads as spelling-out to a screen reader, so the
          animated copy is hidden and a plain one carries the text. */}
      <span className="sr-only">{words[index]}</span>
      <span key={cycle} aria-hidden>
        {renderChars(words[index], phase, staggerMs)}
      </span>
    </span>
  );
};

/**
 * One span per character, each delayed by its position so the word animates as a wave — entering runs
 * first-to-last, leaving runs last-to-first.
 */
function renderChars(
  word: string,
  phase: "in" | "out",
  staggerMs: number,
): ReactNode {
  const chars = [...word];
  return chars.map((char, index) => (
    <span
      key={index}
      className="rotating-char"
      data-dir={phase}
      style={{
        animationDelay: `${(phase === "in" ? index : chars.length - 1 - index) * staggerMs}ms`,
      }}
    >
      {char === " " ? " " : char}
    </span>
  ));
}

export default RotatingText;
