import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { env } from "../../support/env.js";
import { fixtures, missingDeployedTarget } from "../../support/fixtures.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const ready = fixtures.contracts["F-LEG-1"];
const mismatch = fixtures.contracts["F-LEG-3"];
const buildFailed = fixtures.contracts["F-PRIV-BUILDFAILED"];
const unsupported = fixtures.contracts["F-NONE"];
const mismatchArchive = mismatch?.source_path
  ? resolve(repoRoot, mismatch.source_path)
  : undefined;
const buildFailedArchive = buildFailed?.source_path
  ? resolve(repoRoot, buildFailed.source_path)
  : undefined;

const skipReason =
  !env.enabled
    ? "SCVS_E2E is not set — this suite drives a real deployment and never runs by default"
    : !env.allowBrowser
      ? "BROWSER requires SCVS_E2E_ALLOW_BROWSER=1"
      : !env.webUrl
        ? "missing SCVS_E2E_WEB_URL"
        : missingDeployedTarget("F-LEG-1", "F-LEG-3", "F-PRIV-BUILDFAILED", "F-NONE") ??
          (!mismatchArchive || !buildFailedArchive || !existsSync(mismatchArchive) || !existsSync(buildFailedArchive)
            ? "browser journey needs F-LEG-3 and F-PRIV-BUILDFAILED local source archives"
            : undefined);

async function preflight(page: Page, contractId: string) {
  await page.goto(new URL("/verify", env.webUrl).toString(), {
    waitUntil: "networkidle",
  });
  await page.locator("#contractId").fill(contractId);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/verification/v1/preflight" &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Check this contract" }).click();
  expect((await response).status()).toBe(200);
}

// The console refuses every submission until the terms box is ticked.
async function acceptTerms(page: Page) {
  await page.getByTestId("accept-terms").check();
}

// The log arrives folded; opening the panel is what renders its text.
async function openBuildLog(page: Page) {
  const panel = page.getByTestId("build-log");
  await panel.getByRole("button", { name: "Build log" }).click({ timeout: env.requestTimeoutMs });
  return panel.getByTestId("build-log-text");
}

async function submitPublicSource(page: Page, fixtureId: "F-LEG-1") {
  const fixture = fixtures.contracts[fixtureId];
  await page.locator("#source_sha256").fill(fixture.source_sha256!);
  await page.getByLabel("Source URI").fill(fixture.source_uri!);

  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/verification/v1/verifications" &&
      candidate.request().method() === "POST",
  );
  const eventStream = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname.endsWith("/events") && request.method() === "GET",
  );
  await acceptTerms(page);
  await page.getByRole("button", { name: "Submit completed manifest" }).click();

  const submitted = await response;
  expect(submitted.status()).toBe(202);
  await expect(page).toHaveURL(/\/verify\/jobs\/[\w-]+$/, {
    timeout: env.jobTimeoutMs,
  });
  await eventStream;
  return page.url().split("/").at(-1)!;
}

test.describe.serial("E2E-SUB-15 — public console submission journey [BROWSER]", () => {
  test.skip(Boolean(skipReason), skipReason);

  let verifiedJobId: string;
  let mismatchJobId: string;

  // One browser for the whole journey: a job's build-log token is kept only by the browser that submitted it.
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page?.close();
  });

  test("E2E-SUB-15/console_recipe_completion — preflight fields stay visible and editable", async () => {
    await preflight(page, ready.contract_id!);
    await expect(page.getByTestId("preflight-card")).toContainText("This contract can be verified");
    await expect(page.getByRole("heading", { name: "Complete missing evidence" })).toBeVisible();

    for (const id of ["source_sha256", "bldarg", "bldopt"]) {
      await expect(page.locator(`#${id}`)).toBeEditable();
    }
    await expect(page.getByLabel("Source URI")).toBeEditable();

    await page.locator("#source_sha256").fill(ready.source_sha256!);
    await page.getByLabel("Source URI").fill(ready.source_uri!);
    await page.locator("#bldarg").fill((ready.bldarg ?? []).join(" "));
    await page.locator("#bldopt").fill((ready.bldopt ?? []).join(" "));
    await expect(page.locator("#source_sha256")).toHaveValue(ready.source_sha256!);
    await expect(page.getByLabel("Source URI")).toHaveValue(ready.source_uri!);
  });

  test("E2E-SUB-15/console_upload_with_declaration — hashes and declares a public archive", async () => {
    test.setTimeout(env.jobTimeoutMs + 120_000);
    await preflight(page, mismatch.contract_id!);
    await page.getByLabel("Source access mode").click();
    await page.getByRole("option", { name: "Upload archive" }).click();
    await page.locator('input[type="file"]').setInputFiles(mismatchArchive!);

    await expect(page.getByText(`SHA-256 ${mismatch.source_sha256}`)).toBeVisible();
    const declaration = page.getByRole("checkbox", { name: "Publish this source publicly" });
    await expect(declaration).not.toBeChecked();
    await declaration.check();
    await acceptTerms(page);

    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/verification/v1/verifications" &&
        candidate.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Submit completed manifest" }).click();
    const submitted = await response;
    expect(submitted.status()).toBe(202);
    expect(submitted.request().postDataJSON()).toMatchObject({
      manifest: { is_public: true, source_sha256: mismatch.source_sha256 },
      accepted_terms_version: expect.any(String),
    });
    await expect(page).toHaveURL(/\/verify\/jobs\/[\w-]+$/, {
      timeout: env.jobTimeoutMs,
    });
    mismatchJobId = page.url().split("/").at(-1)!;
  });

  test("E2E-SUB-15/console_progress — follows SSE and restores the job after refresh", async () => {
    test.setTimeout(env.jobTimeoutMs + 120_000);
    await preflight(page, ready.contract_id!);
    verifiedJobId = await submitPublicSource(page, "F-LEG-1");

    const shownJob = page.getByText(verifiedJobId, { exact: true });
    await expect(shownJob).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(new RegExp(`/verify/jobs/${verifiedJobId}$`));
    await expect(shownJob).toBeVisible();
  });

  test("E2E-SUB-15/console_verdict — shows verified and mismatch outcomes with both hashes", async () => {
    test.setTimeout(env.jobTimeoutMs + 120_000);
    await page.goto(new URL(`/verify/jobs/${verifiedJobId}`, env.webUrl).toString(), {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("heading", { name: "Verification passed" })).toBeVisible({
      timeout: env.jobTimeoutMs,
    });

    await page.goto(new URL(`/verify/jobs/${mismatchJobId}`, env.webUrl).toString(), {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("heading", { name: "Verification mismatch" })).toBeVisible({
      timeout: env.jobTimeoutMs,
    });
    // The deployed console may lag this workspace's test-id additions, so assert the stable user-visible
    // labels and values.
    await expect(page.getByText(mismatch.wasm_hash!, { exact: true })).toBeVisible();
    await expect(page.getByText("Rebuilt Wasm hash", { exact: true }).first()).toBeVisible();
  });

  test("E2E-SUB-15/console_build_log — exposes the terminal build log", async () => {
    test.setTimeout(env.jobTimeoutMs + 120_000);

    // This source archive reaches rustc and fails there, so it cannot adopt a published verdict.
    await preflight(page, buildFailed.contract_id!);
    await page.getByLabel("Source access mode").click();
    await page.getByRole("option", { name: "Upload archive" }).click();
    await page.locator('input[type="file"]').setInputFiles(buildFailedArchive!);
    await expect(page.getByText(`SHA-256 ${buildFailed.source_sha256}`)).toBeVisible();
    const failedSubmit = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/api/verification/v1/verifications" &&
        candidate.request().method() === "POST",
    );
    await acceptTerms(page);
    await page.getByRole("button", { name: "Submit completed manifest" }).click();
    expect((await failedSubmit).status()).toBe(202);
    await expect(page).toHaveURL(/\/verify\/jobs\/[\w-]+$/, { timeout: env.jobTimeoutMs });
    await expect(page.getByRole("heading", { name: "Build failed" })).toBeVisible({
      timeout: env.jobTimeoutMs,
    });
    const failedLog = await openBuildLog(page);
    await expect(failedLog).not.toBeEmpty();
    await expect(failedLog).toContainText(/error\[E\d+\]|error:/i);

    // A job that reused an earlier rebuild ran no build of its own, and the panel says so; any other
    // state (no token, unreadable) fails. The logs' content is covered through the API by E2E-SUB-10.
    for (const jobId of [verifiedJobId, mismatchJobId]) {
      await page.goto(new URL(`/verify/jobs/${jobId}`, env.webUrl).toString(), {
        waitUntil: "networkidle",
      });
      const panel = page.getByTestId("build-log");
      await expect(panel).toBeVisible({ timeout: env.jobTimeoutMs });
      const noOwnBuild = panel.getByText("No build was started for this job");
      await expect(panel.getByRole("button", { name: "Build log" }).or(noOwnBuild)).toBeVisible({
        timeout: env.requestTimeoutMs,
      });
      if (await noOwnBuild.isVisible()) continue;
      await expect(await openBuildLog(page)).not.toBeEmpty();
    }
  });
});

test.describe("E2E-SUB-15 — unsupported target [BROWSER]", () => {
  test.skip(Boolean(skipReason), skipReason);

  test("E2E-SUB-15/console_disables_unsupported — stops an unsupported target before submission", async ({ page }) => {
    await preflight(page, unsupported.contract_id!);
    await expect(page.getByTestId("preflight-card")).toContainText("cannot be verified");
    await expect(page.getByRole("heading", { name: "Complete missing evidence" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Submit completed manifest" })).not.toBeVisible();
  });
});
