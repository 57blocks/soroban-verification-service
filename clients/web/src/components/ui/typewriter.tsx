import { type ElementType, type ReactNode, useEffect, useState } from "react";

type Phase = "typing" | "holding" | "erasing" | "resting";

export interface TypewriterProps {
  text: string;
  as?: ElementType;
  className?: string;
  typeMs?: number;
  eraseMs?: number;
  startDelayMs?: number;
  holdMs?: number;
  restMs?: number;
  loop?: boolean;
  cursor?: ReactNode;
  cursorClassName?: string;
  renderText?: (shown: string) => ReactNode;
}

export const Typewriter = ({
  text,
  as: Tag = "span",
  className,
  typeMs = 60,
  eraseMs = 40,
  startDelayMs = 0,
  holdMs = 2000,
  restMs = 400,
  loop = true,
  cursor = "|",
  cursorClassName = "",
  renderText,
}: TypewriterProps) => {
  const [length, setLength] = useState(0);
  const [phase, setPhase] = useState<Phase>("resting");
  const [started, setStarted] = useState(startDelayMs === 0);

  useEffect(() => {
    if (started) return;
    const id = window.setTimeout(() => setStarted(true), startDelayMs);
    return () => window.clearTimeout(id);
  }, [started, startDelayMs]);

  useEffect(() => {
    if (!started) return;

    const next = (): [number, () => void] => {
      switch (phase) {
        case "resting":
          return [length === 0 ? 0 : restMs, () => setPhase("typing")];
        case "typing":
          if (length < text.length) return [typeMs, () => setLength((n) => n + 1)];
          return [0, () => setPhase("holding")];
        case "holding":
          if (!loop) return [-1, () => {}];
          return [holdMs, () => setPhase("erasing")];
        case "erasing":
          if (length > 0) return [eraseMs, () => setLength((n) => n - 1)];
          return [restMs, () => setPhase("typing")];
      }
    };

    const [delay, step] = next();
    if (delay < 0) return;
    const id = window.setTimeout(step, delay);
    return () => window.clearTimeout(id);
  }, [started, phase, length, text, typeMs, eraseMs, holdMs, restMs, loop]);

  const shown = text.slice(0, length);

  return (
    <Tag className={className}>
      {renderText ? renderText(shown) : shown}
      <span
        aria-hidden="true"
        className={`ml-1 inline-block animate-caret motion-reduce:animate-none ${cursorClassName}`}
      >
        {cursor}
      </span>
    </Tag>
  );
};
