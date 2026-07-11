import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  workers: 1,
  // Screenshot baselines are machine-generated and never committed (repo
  // convention forbids binary artifacts), so route them to a gitignored dir
  // instead of the default `<spec>-snapshots/` beside the spec.
  snapshotPathTemplate: "test/e2e/__screenshots__/{projectName}-{platform}/{arg}{ext}",
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run build && bun run preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
