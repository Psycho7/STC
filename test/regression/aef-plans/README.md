# AEF-plan regression fixtures

This directory holds JSON fixtures that exercise the full render pipeline
(`solvePlanWithIntermediates` -> `buildRenderPlan` -> `layoutRenderPlan`)
against the AEF recipe pack. Each fixture pins a target list and a small set
of structural expectations against the resulting `RenderPlan`.

The runner lives at `test/regression/aef-plans.test.ts`. It globs
`*.json` in this directory and produces one test case per file. Adding a
new fixture is a drop-in: no code changes required.

## Fixture format

```json
{
  "name": "human-readable description",
  "targets": [
    { "recipeId": "copper_powder", "ratePerSec": { "num": "1", "denom": "60" } }
  ],
  "expectations": {
    "minUnits": 2,
    "expectAtLeastOneBadge": false,
    "expectAtLeastOneLoop": false
  }
}
```

Field reference:

- `name` (string): label used in the test output. Should describe the
  scenario, not the file name.
- `targets` (array): the same `Target[]` shape `defaultTargets()` returns.
  Each entry has a `recipeId` (must exist in `data/aef/recipe-pack.json`)
  and a `ratePerSec` rational expressed as `{num, denom}` strings to keep
  exact precision through JSON.
- `expectations.minUnits` (number): minimum `plan.units.length` after the
  full pipeline runs. Use this as a structural floor (e.g., a target plus
  its required upstream recipes). Keep it loose so unrelated upstream
  refactors do not break the fixture.
- `expectations.expectAtLeastOneBadge` (boolean): if `true`, assert at
  least one `units[*].kind === "badge"` (signals the multiplier-fold path
  fired for some class).
- `expectations.expectAtLeastOneLoop` (boolean): if `true`, assert at
  least one `units[*].kind === "loop"` (signals an SCC was rendered as a
  loop unit).
- `expectations.expectNoIsolatedUnits` (boolean, optional): if `true`,
  assert every non-loop render unit is incident to at least one
  `RenderEdge`. Pins bugs where ExpandMultipliers (or downstream
  stages) silently drop machines from the edge set. Loop units are
  exempt because their I/O is internal to the bounded box.

## Where the larger regression set lives

The broader fixture set is still being collected. Once curated it will land in
this directory verbatim. The scaffold here is intentionally minimal so that the
larger set can be dropped in without any wiring changes.

## Adding a new fixture

1. Pick a representative AEF target (or short target list) that stresses a
   specific pipeline branch: a long linear chain, a shared utility, an SCC,
   a high replication multiplier, etc.
2. Create `test/regression/aef-plans/<descriptive-name>.json` matching the
   shape above. Keep `name` short but specific.
3. Set the expectations conservatively. Prefer floors (`minUnits`) and
   feature flags (`expectAtLeastOne*`) over exact counts; this directory is
   for structural regressions, not snapshot equality.
4. Run `bun run test -- test/regression/aef-plans.test.ts`. The new file
   should be picked up automatically.

## Updating expectations after an intentional pipeline change

If a pipeline change legitimately shifts the output (e.g., a new
multiplier-fold threshold, an SCC tear-edge heuristic change), update the
affected fixture(s) in the same commit as the code change. The fixture is
the canonical signal: if the expectations no longer hold, decide whether
the pipeline change is correct (update the JSON) or unintended (revert the
code). Do not relax expectations to silence failures without a tied-out
explanation.
