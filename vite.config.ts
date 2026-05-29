import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { existsSync } from "node:fs";

function findParentRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (
      existsSync(path.join(dir, "tools/extractor/src/schema.ts")) &&
      existsSync(path.join(dir, "data/aef"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    "Cannot locate parent root containing tools/extractor and data/aef",
  );
}

const parentRoot = findParentRoot(import.meta.dirname);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@aef/data": path.resolve(parentRoot, "data/aef"),
      "@aef/icons": path.resolve(parentRoot, "vendor/factoriolab/src/data/aef"),
      "@aef/schema": path.resolve(parentRoot, "tools/extractor/src/schema.ts"),
    },
  },
  server: {
    fs: { allow: [parentRoot] },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
});
