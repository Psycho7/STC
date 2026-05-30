import { defineConfig } from "vite";
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
});
