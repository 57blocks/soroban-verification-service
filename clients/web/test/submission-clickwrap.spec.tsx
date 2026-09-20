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
 * Why a refused submission is legible. The old shape put the reason in a `title` on a disabled button —
 * a tooltip that needs a hovering mouse, which a touch screen does not have and a disabled element does not
 * reliably fire anyway.
 */
describe("a refused submission", () => {
  test("states the reason on the page, as an alert", async () => {
    await renderInRouter(
      <SubmissionAgreement
        acceptance={{
          accepted: false,
          onAcceptedChange: vi.fn(),
          error: "Accept the Terms of Service and acknowledge the Privacy Notice before submitting.",
        }}
      />,
    );

    const said = screen.getByTestId("accept-terms-blocked");
    expect(said).toHaveAttribute("role", "alert");
    expect(said.textContent).toMatch(/Accept the Terms of Service/);
    expect(screen.getByTestId("accept-terms")).toHaveAttribute("aria-invalid", "true");
  });

  test("says nothing before a submission has been refused", async () => {
    await renderInRouter(
      <SubmissionAgreement acceptance={{ accepted: false, onAcceptedChange: vi.fn() }} />,
    );
    expect(screen.queryByTestId("accept-terms-blocked")).toBeNull();
    expect(screen.getByTestId("accept-terms")).not.toHaveAttribute("aria-invalid");
  });
});
