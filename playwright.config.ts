import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Playwright always passes --disable-dev-shm-usage (kept: containers ship a
// tiny /dev/shm), so Chromium puts its shared memory in $TMPDIR. A per-user
// quota on /tmp then makes fallocate fail mid-test and Chromium crashes on
// purpose, so point the browser's TMPDIR at a gitignored dir in the repo.
const BROWSER_TMPDIR = resolve(
  import.meta.dirname,
  "test-results/.chromium-tmp",
);
mkdirSync(BROWSER_TMPDIR, { recursive: true });

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  workers: 1,
  // Screenshot baselines are machine-generated and never committed (repo
  // convention forbids binary artifacts), so route them to a gitignored dir
  // instead of the default `<spec>-snapshots/` beside the spec.
  snapshotPathTemplate:
    "test/e2e/__screenshots__/{projectName}-{platform}/{arg}{ext}",
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: {
      env: { ...process.env, TMPDIR: BROWSER_TMPDIR },
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // `vite build` alone, not `bun run build`: its `tsc --noEmit` step is
    // already covered by `bun run typecheck` and would add a redundant
    // ~700 MB, ~7 s step to every e2e run.
    command: "bunx vite build && bun run preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
