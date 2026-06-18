import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./test/setup.ts", "./test/encoding-test-env.ts"],
      globals: false,
      // Two Vitest suites run together: the borrowed suite under test/ and the
      // LP-solver's colocated suite under src/ (plus the solver-cli tool test).
      // STC vendors the bun:test extractor at tools/extractor/ (run via
      // `bun test`) and keeps prototype worktrees under .claude/; scope the
      // include so neither leaks into this run.
      include: [
        "test/**/*.{test,spec}.{ts,tsx}",
        "src/**/*.{test,spec}.{ts,tsx}",
        "tools/solver-cli/**/*.{test,spec}.{ts,tsx}",
      ],
      // The Playwright end-to-end specs under test/e2e/ run through
      // `bun run test:e2e`, not here. Keep Vitest away from them: they call
      // test.use() at module scope, and only Playwright's own runner knows what
      // to do with that.
      exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**"],
    },
  }),
);
