import { defineConfig, devices } from "@playwright/test";

// e2e runs against the *built* apps through vite preview, so the CSP headers and the service workers are
// the real production ones. the worker runs under wrangler dev (local kv, fixture photos as assets)
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
    {
      command: "pnpm --filter @unlisted/footprint-api dev",
      url: "http://localhost:8787/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @unlisted/footprint build && pnpm --filter @unlisted/footprint preview",
      url: "http://localhost:4174",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
