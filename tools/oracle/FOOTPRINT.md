# T6 - GLPK footprint vs incumbent (client-side cost)

Predeclared veto thresholds (PLAN section "Key decisions"): veto fires if glpk-wasm adds
> 500 KB gzipped to the client bundle, OR cold init > 250 ms, OR representative solve > 10x
`javascript-lp-solver` on the same scenario.

## T6a - payload size (measured from node_modules)

| Solver | Raw shipped | gzip | Load model |
|---|---|---|---|
| javascript-lp-solver 1.0.3 (incumbent) | 177 KB (dist/index.cjs) | 34 KB | pure JS, synchronous |
| GLPK `glpk.all` (variant used in this prototype) | 1.05 MB (942 KB .wasm + 108 KB .js) | ~355 KB | WASM, async init + fetch |
| GLPK `glpk.min` (smaller variant, if LP-sufficient) | ~350 KB (278 KB .wasm + 71 KB .js) | ~125 KB | WASM, async init |
| GLPK `glpk.mip` (if MIP needed for transfer_* integer vars) | ~508 KB | ~187 KB | WASM, async init |

Size-veto verdict: NOT triggered. `glpk.all` at ~355 KB gzip is under the 500 KB bar; a
tuned `min` variant is ~125 KB gzip. GLPK adds ~4-10x the incumbent's gzip payload plus an
async WASM fetch+compile on app load.

## T6b - init + solve timing

From the T5 corpus run (representative solve times for both solvers) - see corpus-results.md.
Cold WASM init time measured against the 250 ms bar there. Solve-time ratio against the 10x
bar there.

## Notes
- The incumbent is pure JS and synchronous; GLPK requires `await loadModule(...)` before any
  solve, i.e. an app-startup async step and a one-time WASM compile.
- glpk-wasm ships multiple prebuilt variants; the LP-only path likely runs on `glpk.min`,
  but the prototype used `glpk.all` for safety. A production adoption could pick the smallest
  variant that still passes the corpus.
