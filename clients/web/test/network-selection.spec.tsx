import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { TargetCard } from "@/features/verification/components/TargetCard";
import { defaultValues } from "@/features/verification/constants";
import { buildTarget } from "@/features/verification/utils/manifest.util";
import type { VerifyFormValues } from "@/features/verification/types";
import { renderInRouter } from "./render-in-router";

// Radix's Select measures and captures the pointer; jsdom implements neither.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

const Card = () => {
  const form = useForm<VerifyFormValues>({ defaultValues });
  return (
    <TargetCard
      form={form}
      targetType="contract_id"
      onTargetTypeChange={() => {}}
      isSubmitting={false}
      onSubmit={() => {}}
    />
  );
};

/**
 * Mainnet was in the list, disabled, annotated "Soon" — while every route behind it already served both
 * networks.
 */
describe("the network picker offers both networks", () => {
  test("mainnet is selectable, not a greyed placeholder", async () => {
    // The card carries the submission-agreement links, so it needs a router above it.
    await renderInRouter(<Card />);
    await userEvent.click(screen.getByRole("combobox", { name: /network/i }));

    const mainnet = screen.getByRole("option", { name: "Mainnet" });
    expect(mainnet).toBeInTheDocument();
    expect(mainnet).not.toHaveAttribute("data-disabled");
    expect(screen.queryByText("Soon")).not.toBeInTheDocument();
  });

  test("selecting it puts mainnet on the submitted target", async () => {
    expect(buildTarget({ ...defaultValues, network: "mainnet" }).network).toBe("mainnet");
  });

  // The offer is new; the default is not.
  test("testnet is still what the form starts on", () => {
    expect(defaultValues.network).toBe("testnet");
  });
});
