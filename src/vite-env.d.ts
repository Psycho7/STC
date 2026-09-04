/// <reference types="vite/client" />

// The app commit the bundle was built from, baked in by vite.config.ts. Always
// defined, including under vitest, where it falls back to "unknown" when no git
// checkout is reachable.
declare const __STC_COMMIT__: string;

declare module "*.webp?url" {
  const url: string;
  export default url;
}
