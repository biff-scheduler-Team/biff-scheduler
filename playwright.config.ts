import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  webServer: process.env.IFFDAY_ACCOUNT_PATH
    ? {
        command: "npm run dev:account",
        url: `${process.env.BIFF_TEST_ORIGIN ?? "http://localhost:31028"}/api/health`,
        reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
        timeout: 120_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
      }
    : undefined,
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BIFF_TEST_ORIGIN ?? "http://localhost:31028",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
});
