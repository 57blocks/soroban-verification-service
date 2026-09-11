import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import type { AggregatedRegistryVerification } from "soroban-verification-client";
import { PeerLink } from "@/features/aggregator/components/PeerLink";
import { VerifierResult } from "@/features/aggregator/components/VerifierResult";
import { isWasmHash } from "@/features/aggregator/hooks/use-hash-lookup";

// Built as a plain object and cast, rather than through the class: these are fixtures standing in for a
// *peer's* document, and the point of the assertions below is what happens when one carries something the shape
// does not promise.
const entry = (over: Record<string, unknown> = {}): AggregatedRegistryVerification =>
  ({
    verifier: { name: "Peer Verifier", url: "https://peer.example/about" },
    status: "verified",
    processed_at: "2026-08-11T00:00:00.000Z",
    ...over,
  }) as unknown as AggregatedRegistryVerification;

describe("peer content is untrusted (S24)", () => {
  test("a hostile verifier name renders as text, not markup", () => {
    render(<VerifierResult entry={entry({ verifier: { name: "<img src=x onerror=alert(1)>" } })} />);

    const card = screen.getByTestId("verifier-result");
    expect(card.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
  });

  // A peer's `logo_url` would be a fetch this page makes on the peer's instruction.
  test("no image is ever loaded from a peer origin", () => {
    render(
      <VerifierResult
        entry={entry({ verifier: { name: "Peer", logo_url: "https://peer.example/logo.png" } })}
      />,
    );

    expect(screen.getByTestId("verifier-result").querySelector("img")).toBeNull();
  });
});

describe("navigation to a peer destination is gated (S26)", () => {
  test("the origin is shown, and nothing is navigable, until it is confirmed", () => {
    render(<PeerLink url="https://peer.example/deep/path?x=1" label="verifier" />);

    expect(screen.getByTestId("peer-link-pending").textContent).toContain("https://peer.example");
    expect(screen.queryByTestId("peer-link-open")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("confirming reveals a link that cannot reach back into this page", async () => {
    render(<PeerLink url="https://peer.example/deep/path" label="verifier" />);
    await userEvent.click(screen.getByRole("button", { name: /show link/i }));

    const link = screen.getByTestId("peer-link-open");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  test.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "not a url"])(
    "%s is refused outright and never handed to the browser",
    (url) => {
      render(<PeerLink url={url} label="verifier" />);

      expect(screen.getByTestId("peer-link-refused")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    },
  );
});

describe("the input is checked before anything is queried", () => {
  test("only a 64-hex string is a wasm hash", () => {
    expect(isWasmHash("a".repeat(64))).toBe(true);
    expect(isWasmHash(` ${"A".repeat(64)} `)).toBe(true);
    expect(isWasmHash("a".repeat(63))).toBe(false);
    expect(isWasmHash("a".repeat(65))).toBe(false);
    expect(isWasmHash("CAAAA")).toBe(false);
    expect(isWasmHash("")).toBe(false);
  });
});
