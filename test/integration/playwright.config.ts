import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: "../../.env", quiet: true });

export default defineConfig({
  testDir: "./cases",
  testMatch: "**/*.pw.ts",
  outputDir: "../../artifacts/e2e-playwright",
  fullyParallel: false,
  reporter: "list",
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
