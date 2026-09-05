# AEF-plan regression fixtures

This directory holds JSON fixtures that exercise the full render pipeline
(`solvePlanWithIntermediates` -> `renderPlanFromSolve` -> `layoutRenderPlan`)
against the AEF recipe pack. Each fixture pins a target list and a small set
of structural expectations against the resulting `RenderPlan`.

The runner lives at `test/regression/aef-plans.test.ts`. It globs `*.json` in
this directory and produces one test case per file, so adding a fixture needs
no code change. Unknown keys are rejected, which keeps a misspelled or retired
expectation from sitting in the JSON looking live while the runner ignores it.

## Fixture format

```json
{
  "name": "human-readable description",
  "targets": [
    { "itemId": "copper_powder", "ratePerSec": { "num": "1", "denom": "60" } }
  ],
  "itemOverrides": [{ "itemId": "copper_ore", "plan": true }],
  "expectations": {
    "minUnits": 2,
    "expectNoIsolatedUnits": true
  }
}
```

Field reference:

- `name` (string): label used in the test output. Describe the scenario, not
  the file name.
- `targets` (array): the `Target[]` shape `defaultTargets()` returns. Each
  entry is an `itemId` (an item of `data/aef/recipe-pack.json`, not a recipe
  id) plus a `ratePerSec` rational written as `{num, denom}` strings so the
  value stays exact through JSON.
- `itemOverrides` (array, optional, defaults to `[]`): the `ItemOverride[]`
  the Inputs panel produces. An entry is an `itemId` plus either a
  `ratePerSec` rational for a finite supply cap or `"plan": true` to plan
  through an item that would otherwise be treated as raw.
- `expectations.minUnits` (number): floor on `plan.units.length` after the
  full pipeline runs, e.g. a target plus its required upstream recipes. Keep
  it loose so unrelated upstream refactors do not break the fixture.
- `expectations.expectAtLeastOneLoop` (boolean, optional, defaults to
  `false`): assert at least one `units[*].kind === "loop"`. Nothing in the
  pipeline emits a loop unit today, so a fixture that turns this on fails.
- `expectations.expectNoIsolatedUnits` (boolean, optional): assert every
  render unit is incident to at least one `RenderEdge`. Pins bugs where the
  expand stage silently drops machines from the edge set. Loop units and the
  two product kinds are exempt: a loop's I/O is internal to its box, and
  product units are boundary nodes pinned by per-node ELK options rather than
  by edges.
- `expectations.expectTargetOutputDelivered` (boolean, optional, defaults to
  `true`): assert each target's `u:out:<itemId>` unit has at least one
  incoming edge. Pins split-replica deliverer routing, where an SCC member
  that is itself a target needs a boundary edge or no rate leaves the SCC.
- `expectations.expectInputProductFor` (array of item ids, optional): assert
  each listed item surfaces as an `inputProduct` unit. Pins the boundary
  dual-emission rule: an item that is both a target and consumed in-plan
  under a finite override renders an input node beside its output node.

## Adding a new fixture

1. Pick a representative AEF target (or short target list) that stresses a
   specific pipeline branch: a long linear chain, a shared utility, an SCC, a
   high replication multiplier, a capped non-raw import.
2. Create `test/regression/aef-plans/<descriptive-name>.json` matching the
   shape above. Keep `name` short but specific.
3. Set the expectations conservatively. Prefer floors (`minUnits`) and
   feature flags over exact counts; this directory is for structural
   regressions, not snapshot equality.
4. Run `bunx vitest run test/regression/aef-plans.test.ts`. The new file is
   picked up automatically.

Every fixture also inherits a hard DEV gate. The runner sends each plan
through `renderPlanFromSolve`, which asserts the render invariants and throws
under `import.meta.env.DEV` listing every violation. A fixture whose plan is
dirty crashes the test case instead of failing an expectation, so read the
thrown message first. If the plan is dirty for a known, accepted residual,
set `vi.stubEnv("DEV", false)` around that one fixture's case -- not for the
whole runner -- with a comment naming the residual, rather than relaxing the
fixture's expectations.

## Updating expectations after an intentional pipeline change

If a pipeline change legitimately shifts the output, update the affected
fixtures in the same commit as the code change. The fixture is the canonical
signal: if the expectations no longer hold, decide whether the pipeline change
is correct (update the JSON) or unintended (revert the code). Do not relax
expectations to silence failures without a tied-out explanation.
