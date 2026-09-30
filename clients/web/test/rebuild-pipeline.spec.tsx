import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { RebuildPipeline } from "@/features/landing/components/RebuildPipeline";
import { pipelineSample } from "@/features/landing/content";

describe("RebuildPipeline without a timeline", () => {
  test("renders every sample value as text", () => {
    render(<RebuildPipeline />);
    for (const value of Object.values(pipelineSample)) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
  });

  test("shows the real digests, not a scramble frame", () => {
    const { container } = render(<RebuildPipeline />);
    const spans = [
      ...container.querySelectorAll<HTMLElement>("[data-scramble]"),
    ];
    expect(spans).toHaveLength(4);
    for (const span of spans) {
      expect(span.textContent).toBe(span.dataset.scramble);
    }
  });
});
