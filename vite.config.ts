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
    exclude: [...configDefaults.exclude, "**/tools/extractor/**"],
  },
});
