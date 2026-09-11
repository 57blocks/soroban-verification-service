import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { BuildLogPanel } from "@/features/verification/components/BuildLogPanel";
import type { BuildLogUnavailableResponse } from "@scvs/verify-api-client";

const unavailable = (over: Partial<BuildLogUnavailableResponse> = {}): BuildLogUnavailableResponse => ({
  schema_version: "1.0",
  status_code: 404,
  error: "not_found",
  message: "No build log was recorded for this job.",
  ...over,
});

describe("a job with no build log (UI2, and the common case today)", () => {
  // `not_attempted` is what an `unsupported` job reports: the route maps through `toWireVerificationStatus`, so
  // this carries the external vocabulary and never the internal `JobStatus`.
  test("renders the reason rather than an empty pane", () => {
    render(
      <BuildLogPanel
        state={{
          phase: "unavailable",
          body: unavailable({ job_status: "not_attempted", failure_reason: "unsupported" }),
        }}
      />,
    );

    expect(screen.getByTestId("build-log")).toBeInTheDocument();
    expect(screen.getByText(/Job status: not_attempted/)).toBeInTheDocument();
    expect(screen.getByText(/Reason: unsupported/)).toBeInTheDocument();
    expect(screen.queryByTestId("build-log-text")).not.toBeInTheDocument();
  });

  test("falls back to the message when the body carried no status or reason", () => {
    render(<BuildLogPanel state={{ phase: "unavailable", body: unavailable() }} />);

    expect(screen.getByText("No build log was recorded for this job.")).toBeInTheDocument();
  });

  test("says why there is no log, not that fetching it failed", () => {
    render(<BuildLogPanel state={{ phase: "unavailable", body: unavailable({ job_status: "queued" }) }} />);

    expect(screen.getByText(/No build was started for this job/)).toBeInTheDocument();
  });
});

const openLog = async () => {
  await userEvent.click(screen.getByRole("button", { name: /Build log/ }));
};

describe("a log that exists", () => {
  test("is behind a disclosure, closed on arrival", () => {
    render(<BuildLogPanel state={{ phase: "log", text: "line one\nline two" }} />);

    expect(screen.getByRole("button", { name: /Build log/ })).toBeInTheDocument();
    expect(screen.queryByTestId("build-log-text")).not.toBeInTheDocument();
  });

  test("is rendered in full once opened", async () => {
    render(<BuildLogPanel state={{ phase: "log", text: "line one\nline two" }} />);
    await openLog();

    expect(screen.getByTestId("build-log-text").textContent).toBe("line one\nline two");
  });

  // The log is the sandbox's output — the untrusted side of the trust boundary.
  test("is text, never markup", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    render(<BuildLogPanel state={{ phase: "log", text: hostile }} />);
    await openLog();

    const pane = screen.getByTestId("build-log-text");
    expect(pane.textContent).toBe(hostile);
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.querySelector("script")).toBeNull();
  });

  // The folding is a display concern and must never drop a byte.
  test("folds routine lines into an expandable row, and says how many", async () => {
    const text = [
      "$ cargo vendor",
      ...Array.from({ length: 12 }, (_, i) => `   Downloaded crate${i} v1.0.0`),
      "✅ Build Complete",
    ].join("\n");
    render(<BuildLogPanel state={{ phase: "log", text }} />);

    expect(screen.getByText(/12 routine lines folded/)).toBeInTheDocument();
    await openLog();

    // The signal line is visible without expanding the folded run.
    expect(screen.getByTestId("build-log-text").textContent).toMatch(/✅ Build Complete/);
    expect(screen.getByText("Downloaded 12 crates")).toBeInTheDocument();
  });
});

describe("the other two outcomes stay distinguishable", () => {
  test("unreadable is not the same as absent", () => {
    render(<BuildLogPanel state={{ phase: "unreadable" }} />);

    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByText(/No build was started/)).not.toBeInTheDocument();
  });

  test("idle renders nothing at all", () => {
    const { container } = render(<BuildLogPanel state={{ phase: "idle" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
