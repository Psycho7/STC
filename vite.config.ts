import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@aef/data": path.resolve(root, "data/aef"),
      "@aef/icons": path.resolve(root, "vendor/endfield-calc"),
      "@aef/schema": path.resolve(root, "tools/extractor/src/schema.ts"),
    },
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
