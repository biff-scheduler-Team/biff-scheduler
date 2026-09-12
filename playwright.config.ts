import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 3,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:31029",
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "desktop-chromium",
      testIgnore: "**/parity-mobile.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1512, height: 982 },
      },
    },
    {
      name: "mobile-chromium",
      testIgnore: [
        "**/offline.spec.ts",
        "**/desktop.spec.ts",
        "**/parity-schedule.spec.ts",
      ],
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "mobile-webkit",
      testIgnore: [
        "**/offline.spec.ts",
        "**/desktop.spec.ts",
        "**/parity-schedule.spec.ts",
      ],
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 31029 --strictPort",
    url: "http://127.0.0.1:31029",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
