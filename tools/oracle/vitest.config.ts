import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [
      // Match the tsconfig `~/*` -> flab/src/app/* and `src/environments` aliases.
      {
        find: /^~\/(.*)$/,
        replacement: path.resolve(root, 'flab/src/app') + '/$1',
      },
      {
        find: 'src/environments',
        replacement: path.resolve(root, 'flab/src/environments/index.ts'),
      },
      // The adapter + its test reuse STC's own pack-loading code, which imports
      // the recipe pack and schema through these aliases (mirrors vite.config.ts
      // at the repo root). `worktreeRoot` is two levels up from tools/oracle.
      {
        find: '@aef/data',
        replacement: path.resolve(root, '../../data/aef'),
      },
      {
        find: '@aef/schema',
        replacement: path.resolve(root, '../../tools/extractor/src/schema.ts'),
      },
    ],
  },
  test: {
    include: [
      'tools/oracle/smoke.test.ts',
      'tools/oracle/adapter.test.ts',
      'tools/oracle/compare.test.ts',
      'tools/oracle/gate.test.ts',
      'tools/oracle/corpus-run.test.ts',
      'tools/oracle/real-pack-sweep.test.ts',
      'tools/oracle/small-rate-crosscheck.test.ts',
    ],
    // Resolve the wasm path relative to the worktree root, not the config dir.
    root: path.resolve(root, '../..'),
  },
});
