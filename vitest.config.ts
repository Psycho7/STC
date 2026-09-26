import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Two Vitest suites run together: the borrowed suite under test/ and the
// LP-solver's colocated suite under src/ (plus the solver-cli tool test).
// STC vendors the bun:test extractor at tools/extractor/ (run via
// `bun test`) and keeps prototype worktrees under .claude/; scope the
// include so neither leaks into this run.
const TEST_ROOTS = ["test", "src", "tools/solver-cli", "tools/exam"];

// Component tests (.tsx) and the few .ts tests that touch the DOM run in
// jsdom; everything else runs in plain node. A jsdom environment costs each
// worker a few hundred MB and about half a second per file, which the solver
// and pipeline tests never use.
const DOM_TESTS = [
  ...TEST_ROOTS.map((root) => `${root}/**/*.{test,spec}.tsx`),
  "src/canvas/envBanner.test.ts",
  "src/canvas/exportPng.test.ts",
  "src/data/availability.test.ts",
];

const ENCODING_SETUP = "./test/encoding-test-env.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: false,
      // The colocated src/ suite includes solve-heavy LP tests (the full-pack
      // render corpus sweep, large add-target flows) and integration tests that
      // wait up to 10s. They clear the 5s default locally but not on the slower
      // CI runner, so give every test and hook generous headroom.
      testTimeout: 30000,
      hookTimeout: 30000,
      // The Playwright end-to-end specs under test/e2e/ run through
      // `bun run test:e2e`, not here. Keep Vitest away from them: they call
      // test.use() at module scope, and only Playwright's own runner knows what
      // to do with that.
      exclude: ["**/node_modules/**", "**/dist/**", "test/e2e/**"],
      projects: [
        {
          extends: true,
          test: {
            name: "dom",
            environment: "jsdom",
            setupFiles: ["./test/setup.ts", ENCODING_SETUP],
            include: DOM_TESTS,
          },
        },
        {
          extends: true,
          test: {
            name: "node",
            environment: "node",
            setupFiles: [ENCODING_SETUP],
            include: TEST_ROOTS.map((root) => `${root}/**/*.{test,spec}.ts`),
            exclude: DOM_TESTS,
          },
        },
      ],
    },
  }),
);
