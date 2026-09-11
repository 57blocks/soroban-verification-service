import { expect, test } from "@playwright/test";
import { env } from "../../support/env.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";

const skipReason =
  !env.enabled
    ? "SCVS_E2E is not set — this suite drives a real deployment and never runs by default"
    : !env.allowBrowser
      ? "BROWSER requires SCVS_E2E_ALLOW_BROWSER=1"
      : !env.webUrl
        ? "missing SCVS_E2E_WEB_URL"
        : missingFixture("F-LEG-1");

test.describe("E2E-WEB-01 — the public verification console reaches preflight [BROWSER]", () => {
  test.skip(Boolean(skipReason), skipReason);

  test("loads the deployed console and displays a successful preflight", async ({ page }) => {
    const target = fixtures.contracts["F-LEG-1"];

    await page.goto(new URL("/verify", env.webUrl).toString(), { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Contract to verify" })).toBeVisible();
    await page.locator("#contractId").fill(target.contract_id!);
    const preflightResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/verification/v1/preflight" && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Check this contract" }).click();

    expect((await preflightResponse).status()).toBe(200);
    await expect(page.getByTestId("preflight-card")).toContainText("This contract can be verified");
  });
});
