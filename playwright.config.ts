import { defineConfig, devices } from "@playwright/test";

/**
 * P6 browser gate (design contract D10). Drives the real dashboard served by
 * the CLI (`node packages/cli/dist/index.js serve`) against a throwaway SQLite
 * config store. Requires `pnpm build` first and a one-time
 * `pnpm exec playwright install chromium`.
 */
export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./build/tmp/browser-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:18080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // Both projects share one stateful fixture namespace, so entity-writing
    // specs would collide across projects. Narrow runs the read-only
    // responsive-layout spec; desktop covers the full CRUD/conflict matrix.
    {
      name: "narrow",
      grep: /narrow viewport/u,
      use: { ...devices["Desktop Chrome"], viewport: { width: 420, height: 800 } },
    },
  ],
  webServer: {
    command: "node tests/browser/start-fixture.mjs",
    url: "http://127.0.0.1:18080/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
