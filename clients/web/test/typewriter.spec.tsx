import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Typewriter } from "@/components/ui/typewriter";

const shown = (container: HTMLElement) => (container.firstElementChild?.textContent ?? "").replace(/\|$/, "");

const advance = async (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
  }
};

describe("Typewriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("types after the start delay, holds, erases and types again", async () => {
    const { container } = render(
      <Typewriter text="abc" typeMs={100} eraseMs={50} startDelayMs={500} holdMs={1000} restMs={200} />,
    );

    await advance(490);
    expect(shown(container)).toBe("");

    await advance(330);
    expect(shown(container)).toBe("abc");

    await advance(900);
    expect(shown(container)).toBe("abc");

    await advance(250);
    expect(shown(container)).toBe("");

    await advance(320);
    expect(shown(container)).toBe("a");
  });

  test("stops at the full text when it does not loop", async () => {
    const { container } = render(<Typewriter text="ab" typeMs={10} holdMs={10} loop={false} />);

    await advance(500);
    expect(shown(container)).toBe("ab");
  });

  test("hands the typed prefix to renderText", async () => {
    const { container } = render(
      <Typewriter text="hey" typeMs={10} loop={false} renderText={(prefix) => <b>{prefix.toUpperCase()}</b>} />,
    );

    await advance(100);
    expect(container.querySelector("b")?.textContent).toBe("HEY");
  });
});
