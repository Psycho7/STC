# solver-cli

Forward-trace debug entry point: loads the recipe pack, resolves targets, runs
the LP solver, and prints the result plus validation verdicts. No web layer.

## Usage

```
bun run tools/solver-cli/main.ts --plan <spec> [--mode full|rates]
bun run tools/solver-cli/main.ts --hash <planHash> [--mode full|rates]
```

Exactly one of `--plan` or `--hash` must be given.

### --plan spec

Comma-separated list of `recipeId=rate` entries. Accepted rate forms:

| Form        | Example       | Stored as          |
|-------------|---------------|--------------------|
| `num/denom` | `6/60`        | `{num:"6",denom:"60"}` |
| integer     | `2`           | `{num:"2",denom:"1"}`  |
| decimal     | `0.1`         | `{num:"1",denom:"10"}` |

Both sides of `num/denom` must be non-negative integers and `denom` must not be `0`; otherwise the CLI exits nonzero with a parse error.

Example:

```
bun run tools/solver-cli/main.ts --plan xiranite_enr_powder=0.1
bun run tools/solver-cli/main.ts --plan xiranite_enr_powder=6/60,iron_powder=0.25
```

### --hash

Accepts a plan hash in the `v1.<base64url>` envelope format used by the app URL
fragment (with or without a leading `#`). The hash is decoded using
`src/data/plan.ts:loadPlan` and the pack is validated against the embedded
schema version.

```
bun run tools/solver-cli/main.ts --hash v1.H4sI...
```

### --mode

- `rates` (faster): prints LP rates, objective, status, softFeasible, surplus,
  deficit. No invariant checks.
- `full` (default): also runs all invariant checkers and the optimality screen.

## Output format

Output is line-oriented key=value. Maps are sorted by id so output is
deterministic across runs with the same input.

```
objective=<number>
status=feasible|infeasible|unbounded|empty
softFeasible=true|false

# rates
recipeId=<fraction>
...

# surplus          (omitted when empty)
itemId=<fraction>
...

# deficit          (omitted when empty)
itemId=<fraction>
...

# invariants       (full mode only)
massBalance ok=true|false
targetsMet ok=true|false
rawOnlyBoundary ok=true|false
representable ok=true|false
noOrphanLogicalNodes ok=true|false   <- informational graph finding, never gates the run
optimal ok=true|false
  violation: <description>           (one line per violation, indented)
```

Fractions are printed as `n/d` (exact rational) or as a plain integer when
the denominator is 1.

## Known findings

`noOrphanLogicalNodes` reports any logical recipe node the LP gives zero rate.
The CLI prints the verdict as-is and does NOT exit non-zero because of it, so a
graph-assembly orphan surfaces without failing the run. The stock recipe pack
currently reports `ok=true`.

## Exit codes

- `0`: successful solve and print (even if invariants report violations).
- `1`: bad arguments or fatal solve error.

## Running tests

```
bunx vitest run tools/solver-cli
```
