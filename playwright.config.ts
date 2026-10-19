import { defineConfig, devices } from "@playwright/test";

// e2e runs against the *built* apps through vite preview, so the CSP headers and the service worker are
// the real production ones
export default defineConfig({
  testDir: ".",
  testMatch: ["apps/*/e2e/**/*.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @unlisted/scrub build && pnpm --filter @unlisted/scrub preview",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
