# STC -> FactorioLab GLPK adapter: modeling notes

Prototype branch: `prototype/001-glpk-oracle-eval`. Implements PLAN-001 T2.

`adapter.ts:buildAdapterInput({ pack, targets, itemOverrides })` returns the
`{objectives, settings, data}` triple consumed by
`SimplexService.solve(objectives, settings, data, paused=false)`. The goal is
fidelity: hand GLPK the SAME problem STC's `solveLp` (`src/solver/lp.ts`) builds.

## Port note (develop worktree, game v1.4, item-target model)

This harness was ported from the prototype onto `develop`. Three deltas from
the text below, all because the STC solver changed since the prototype:

1. **Targets are item-shaped** (`{itemId, ratePerSec}`; `ItemTarget` in
   `src/data/targets.ts`). STC's LP meets per-item demand (`demandByItem`) and
   picks producers on cost -- it no longer pins a specific target RECIPE. The
   adapter emits an item-Output objective on `t.itemId` directly. Consequence:
   non-equivalence #1 (pin-recipe vs pin-item) below is **DISSOLVED** -- both
   solvers now meet item demand and choose producers freely, so a multi-producer
   TARGET item no longer forces a divergence.
2. **Both sides net self-consumption.** The pipeline runs
   `netSelfConsumption(rawPack)` before `solveLp` (`src/solver/index.ts`), so
   the oracle nets on both sides too (`compare.ts:nettedScenario`). Idempotent
   and a no-op on the synthetic micro-packs; it only reshapes the real v1.4 pack.
3. **Section 2's 4:1 headline is stale.** Under v1.4 the `xiranite_enr_powder`
   plan no longer routes through `liquid_xiranite_poly`/`-purifier` (v1.4 added
   a sewage loop + `sewage-treat-export`); the cost-min optimum takes the gas /
   phase-transition route. `adapter.test.ts` now asserts the fidelity claim
   directly instead of the 4:1 ratio: STC and GLPK agree recipe-by-recipe on the
   headline with EXACT rate equality (units fix), and the sole target producer
   `phase_trans_2-xiranite_enr_powder` runs at its forced closed-form rate
   (demand/output-qty = (1/10)/2 = 1/20 exec/sec, 1/2 machine).

## 1. STC -> FactorioLab modeling map

| STC concept | STC mechanism (`src/solver/lp.ts`) | FactorioLab mapping (adapter) |
| --- | --- | --- |
| Recipe execution variable `x_r` (executions/sec) | LP var `x_${r.id}` | Recipe variable, value = `machines` = `x_r * time`. Ratio between same-`time` recipes is preserved. |
| Recipe net coefficient | `outQty - inQty` per execution | `AdjustedRecipe.output[item] = (out - in)/time` (via `finalizeRecipe`). |
| Target (pin recipe >= rate) | `x_target >= rate/primary.qty` AND `demandByItem` adds `rate` to `recipe.out[0].item` | Item-**Output** objective on `recipe.out[0].item`, value = `ratePerSec`. Mirrors `demandByItem`; see non-equivalence #1. |
| Raw / boundary item (free source) | `effectiveSupply === Infinity` -> item dropped from mass balance, unbounded | Item with NO producing recipe (`unproduceable`); FactorioLab supplies it freely at `costs.unproduceable`. |
| `itemOverride { plan:true }` or bare boundary marker | `effectiveSupply === Infinity` | Same as raw: free no-recipe item. |
| `itemOverride { ratePerSec: X }` (finite supply cap) | `effectiveSupply === Fraction(X)`, enters mass balance as a constant supply term | Item-**Input** objective, value = `X` -> a capped free input var (`ub = X`). |
| `itemOverride { ratePerSec: 0 }` / non-raw, no producer | `Fraction(0)` -> built internally or surfaces as deficit | No objective; if genuinely unproduced it becomes `unproduceable` (FactorioLab) the same way STC leaves a deficit. |
| Recipe cost weight | `recipeCostWeight`: normal=1, big-M (1e6) for `target-only` / `cost===-1` / `__domain_transfer` / extraction | `AdjustedRecipe.cost` comes from the same `recipeCostWeight` call, so the two cannot drift. Its extraction branch never fires here: extraction recipes are filtered out of the model first. |
| Extraction recipe (empty `in`: the miners and pumps) | No `x_r` variable at all - `solveLp` filters them out, so no cost can make one run and a capped raw item reports a deficit instead | Absent from `adjustedRecipe` and both index maps (`modelRecipes` filter). Not a cost difference on either side: the recipe exists in neither model. |
| Surplus penalty | `SURPLUS_WEIGHT = 1e-3` | `costs.surplus = 1/1000`. Also flips FactorioLab onto the `itemAvailableIoRecipeIds` net-balance path. |
| Deficit penalty | `DEFICIT_WEIGHT = 1e9` | No direct analogue; FactorioLab has no deficit var. Unmet demand => infeasible solve instead (non-equivalence #4). |
| Item id list / stack | `pack.items` | `data.itemIds`, `data.itemEntities[id].stack` (only `.stack` is read; `fluidCostRatio` flag left off so the value is inert). |
| `domain_key_tundra` | ordinary raw item in the pack | Forced into `itemIds`/`itemEntities`/maps as a free no-recipe item (T1 hardcode, see #5). |

### Cost profile chosen (Tier-3 alignment, documented not asserted)

```
factor=1  machine=1  footprint=0  unproduceable=1/1000
excluded=0  surplus=1/1000  maximize=-1e6  recycling=1
```

Recipe-var cost (= ~machine count, since a recipe var is "machines") is the
dominant objective term: normal recipes cost 1, so the objective is essentially
"minimize total machines" with a tiny surplus tie-breaker. `unproduceable` is a
small positive so drawing a free boundary item is cheap but not strictly free
(keeps GLPK from gratuitously over-drawing). This is intended only to make the
machine count dominate for the Tier-3 (record-only) comparison; it is NOT a
match to STC's exact objective and need not be.

## 2. The 4:1 fidelity check: AGREE

Headline plan: one target on `xiranite_enr_powder` at `6/60 = 0.1` enr_powder/sec.
STC pins the two `liquid_xiranite_poly` producers to:

- `liquid_xiranite_poly` (main) = `2/5` exec/sec
- `liquid_xiranite_poly-purifier` = `1/10` exec/sec  -> 4:1 main:purifier.

Both recipes have `time = 2`, so FactorioLab machine count = `exec/sec * time`:

- main = `2/5 * 2 = 4/5` machines
- purifier = `1/10 * 2 = 1/5` machines  -> 4:1, identical ratio.

The adapter test asserts BOTH the exact `4/5` and `1/5` machine counts and the
`4:1` ratio, and they hold exactly in Rational arithmetic. The scenario also
covers the byproduct/disposal axis: main outputs `liquid_xiranite_lowpoly:1`,
the purifier consumes `4` of it to make `1` poly + `1` water, and GLPK closes
that internal loop with zero lowpoly surplus (matching STC). This is a strong
early adapter-fidelity signal across the single-producer-chain, multi-producer
(two poly producers), byproduct, and raw-item (`liquid_water`, `liquid_acid`,
etc.) modeling axes simultaneously.

## 3. Where the two models are NOT cleanly equivalent (feeds gap-list section 4)

1. **Target = pin-recipe vs pin-item.** STC pins the specific target RECIPE
   (`x_target >= rate/qty`), guaranteeing that exact recipe runs. The adapter
   emits an item-Output objective on the target's primary output, letting GLPK
   satisfy the demand with ANY producer of that item. These coincide only when
   the target item has a single producer. With multiple producers GLPK is free
   to pick a cheaper alternate that STC would not (STC forces the named recipe).
   `adapter.ts` could be extended to emit a recipe-Machines objective to pin the
   recipe; left as the simpler item objective per the T2 brief. Gate scenarios
   with multi-producer TARGET items must account for this.

2. **Recipe variable units differ by `time`.** STC's variable is executions/sec;
   FactorioLab's is machines (= exec/sec * recipe `time`). Rate equality
   assertions (Tier 2) must compare STC `x_r` against FactorioLab `machines / time`,
   NOT raw values. Ratios between recipes of equal `time` are unaffected (why the
   4:1 check works on raw machine counts). T4 closed-form fixtures must bake the
   `time` factor in.

3. **Free-source cost is 0 in STC, >0 in FactorioLab.** STC raw/boundary supply
   is strictly free (no objective term). FactorioLab charges `costs.unproduceable`
   per unit drawn. We set it small (1/1000) so it never reorders the
   machine-dominated objective, but it is not zero. On a problem where two raw
   draws trade off against each other this could break a tie differently from STC.

4. **No deficit variable in FactorioLab.** STC models unmet demand with a
   big-M deficit var, so a structurally infeasible target returns
   `softFeasible=false` with a deficit, still "feasible" status. FactorioLab has
   no such var: the same problem comes back as a failed/infeasible solve
   (`resultType !== 'solved'`). The status taxonomy (PROTOTYPE-001 section 6)
   must map STC `feasible + softFeasible=false (deficit)` to GLPK `infeasible`.
   This is a real modeling divergence, not an adapter bug.

5. **`domain_key_tundra` Limit-0 hardcode (T1 / vendored-solver artifact).**
   `SimplexService.solve()` unconditionally appends a `domain_key_tundra` Limit
   objective with value 0 (a fork-specific cross-region-transfer hack) and
   assumes the id exists in every dataset map; absent, `recipeMatches` throws.
   The adapter injects `domain_key_tundra` as a free no-recipe boundary item in
   `itemIds`, `itemEntities`, and all three index maps. Net effect: the
   `__domain_transfer` recipes (which consume `domain_key_tundra`) are capped to
   0 consumption, so they cannot run -- which happens to align with STC pushing
   them to big-M cost, but the mechanism is different (hard cap vs expensive).
   There are also unused-here hardcodes: `transfer_*` recipe ids forced to
   integer vars, and a `xiranite_oven_1` machine-limit black-list entry, both
   only triggered by `MachineLimit` objectives the adapter never emits.

6. **`surplus > 0` switches FactorioLab's net-balance map.** With
   `costs.surplus > 0`, `recipeMatches`/net constraints use
   `itemAvailableIoRecipeIds` (producers AND consumers) instead of
   `itemAvailableRecipeIds` (producers only). The adapter builds the io map to
   include consumers and excludes producers of free items, so a recipe can DRAW
   a free item but the free item is never "produced" in mass balance (mirroring
   STC leaving free items out of its equalities). If a future scenario sets
   `surplus = 0`, the consumer-pull behavior changes and the maps would need
   re-checking.

## 4. Things that will complicate T4 (closed-form gate fixtures)

- **`time` factor (non-eq #2):** every closed-form fixture must express the
  expected FactorioLab answer as `machines = exec/sec * time`, not as STC's raw
  rate. A 1:1, time=1 micro-pack avoids this (smoke.test.ts already does); any
  fixture with `time != 1` or mixed times needs the conversion spelled out.
- **Multi-producer TARGET items (non-eq #1):** if a gate fixture puts a target on
  an item with >1 producer, STC and GLPK will legitimately disagree on which
  producer runs. Either pin via a recipe-Machines objective (adapter extension)
  or keep gate targets single-producer.
- **Infeasible/deficit fixtures (non-eq #4):** the infeasible gate member cannot
  assert "both feasible"; it must assert STC `softFeasible=false` (or status)
  against GLPK `resultType !== 'solved'`. The taxonomy mapping is the fixture's
  acceptance criterion, not a rate match.
- **Free-source tie-break (non-eq #3):** a fixture that pits two raw draws against
  each other may need `costs.unproduceable = 0` to exactly match STC's free
  supply, or must avoid such ties.
- **Integer/machine-limit hardcodes (non-eq #5):** keep `transfer_*` recipe ids
  and `MachineLimit` objectives out of gate fixtures, or the vendored solver will
  silently switch to MIP/integer mode and the closed-form LP answer will not hold.

## 5. How inputs are loaded

The adapter and test reuse STC's own pack-loading path: `src/data/load.ts`
exports `pack` via the `@aef/data` / `@aef/schema` aliases (added to
`tools/oracle/vitest.config.ts` and `tools/oracle/tsconfig.json`, mirroring the
repo-root `vite.config.ts`). Recipes are converted to FactorioLab
`AdjustedRecipe` via the vendored `parseRecipe` + `finalizeRecipe` (no
reinvention of the net-output / `produces` derivation).
