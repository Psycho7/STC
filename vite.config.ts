import { defineConfig, configDefaults } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { resolveCommitStamp } from "./tools/build/commit-stamp";

const root = import.meta.dirname;

// Resolved once per config load, so every chunk and the html carry the same
// value even though they are emitted at different points in the build.
const commitStamp = resolveCommitStamp();

// Stamps the app commit into the served html. The meta tag is the surface a
// deploy check can read with one curl and no browser; the __STC_COMMIT__
// constant below is the one the exam hook hands to a capture. Both come from
// the same string on purpose - two surfaces that could disagree would prove
// nothing about the build being served.
function commitStampPlugin(commit: string): Plugin {
  return {
    name: "stc-commit-stamp",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { name: "stc-commit", content: commit },
        injectTo: "head",
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), commitStampPlugin(commitStamp)],
  resolve: {
    alias: {
      "@aef/data": path.resolve(root, "data/aef"),
      "@aef/icons": path.resolve(root, "vendor/endfield-calc"),
      "@aef/schema": path.resolve(root, "tools/extractor/src/schema.ts"),
    },
  },
  // Baked in rather than read from import.meta.env so it is present under
  // vitest too, where no html is served; resolveCommitStamp falls back to
  // "unknown" when there is no git to ask.
  define: {
    __STC_COMMIT__: JSON.stringify(commitStamp),
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  test: {
    // The extractor is a Bun subpackage with its own `bun test` runner; its
    // specs import bun:test, which vitest cannot resolve. Run them via bun.
    //
    // The GLPK vendor-oracle harness under tools/oracle has its own vitest
    // config (tools/oracle/vitest.config.ts) with the `~` -> flab alias and
    // the glpk-wasm setup; the main suite cannot resolve those imports, so it
    // is excluded here and run separately.
    exclude: [
      ...configDefaults.exclude,
      "**/tools/extractor/**",
      "**/tools/oracle/**",
    ],
  },
});
