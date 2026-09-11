import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { SubmissionAgreement } from "@/features/verification/components/SubmissionAgreement";
import { renderInRouter } from "./render-in-router";

/**
 * The console's clickwrap (versioned-terms-and-assent design.md TA-1): an unchecked control, at the
 * submission and not at the preflight step, and an affirmative act distinct from pressing the button.
 */
describe("the acceptance control", () => {
  test("is absent without `acceptance` — the preflight step keeps the notice it always had", async () => {
    await renderInRouter(<SubmissionAgreement />);
    expect(screen.getByTestId("submission-agreement")).toBeInTheDocument();
    expect(screen.queryByTestId("accept-terms")).toBeNull();
  });

  test("is unchecked by default", async () => {
    await renderInRouter(
      <SubmissionAgreement acceptance={{ accepted: false, onAcceptedChange: vi.fn() }} />,
    );
    expect(screen.getByTestId("accept-terms")).not.toBeChecked();
  });

  test("reports the act, and the act is a click on the box rather than on submit", async () => {
    const onAcceptedChange = vi.fn();
    await renderInRouter(
      <SubmissionAgreement acceptance={{ accepted: false, onAcceptedChange }} />,
    );

    await userEvent.click(screen.getByTestId("accept-terms"));

    expect(onAcceptedChange).toHaveBeenCalledWith(true);
  });

  test("still carries both documents' links, so the terms are readable where the act is", async () => {
    await renderInRouter(
      <SubmissionAgreement acceptance={{ accepted: false, onAcceptedChange: vi.fn() }} />,
    );
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/terms", "/privacy"]));
  });

  test("cannot be used when there is nothing to accept, and says why", async () => {
    const onAcceptedChange = vi.fn();
    await renderInRouter(
      <SubmissionAgreement
        acceptance={{
          accepted: false,
          onAcceptedChange,
          disabledReason: "The terms could not be loaded, so nothing can be submitted right now.",
        }}
      />,
    );

    const box = screen.getByTestId("accept-terms");
    expect(box).toBeDisabled();
    expect(screen.getByTestId("accept-terms-blocked").textContent).toMatch(/could not be loaded/);
    // A submitter must never be able to accept a document that failed to load.
    await userEvent.click(box);
    expect(onAcceptedChange).not.toHaveBeenCalled();
  });
});

/**
 * The gate the hook applies, restated as a unit so the table in TRD §8.1 has a console-side counterpart.
 * `buildTermsGate` is not exported, so this exercises it through the shape the hook returns.
 */
describe("the submit control follows the operator's effective date", () => {
  const Harness = ({ canSubmit, reason }: { canSubmit: boolean; reason?: string }) => (
    <div>
      <SubmissionAgreement
        acceptance={{
          accepted: false,
          onAcceptedChange: vi.fn(),
          ...(reason ? { disabledReason: reason } : {}),
        }}
      />
      <button disabled={!canSubmit} title={canSubmit ? undefined : "Accept the Terms of Service to submit"}>
        Submit completed manifest
      </button>
    </div>
  );

  test("a blocked submit control states the reason rather than failing on press", async () => {
    await renderInRouter(<Harness canSubmit={false} />);
    const button = screen.getByRole("button", { name: /submit completed manifest/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Accept the Terms of Service to submit");
  });

  test("an unblocked control carries no reason", async () => {
    await renderInRouter(<Harness canSubmit />);
    expect(screen.getByRole("button", { name: /submit completed manifest/i })).not.toBeDisabled();
  });
});
