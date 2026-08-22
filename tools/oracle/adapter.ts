// STC -> FactorioLab GLPK-solver adapter.
//
// Translates an STC recipe pack + solve request (targets + itemOverrides) into
// the `(objectives, settings, data)` triple consumed by
// `SimplexService.solve(objectives, settings, data, paused)`.
//
// The point of this file is FIDELITY: it must hand FactorioLab's GLPK solver
// the SAME optimization problem STC's `solveLp` (src/solver/lp.ts) builds, so a
// later cross-solver comparison is meaningful. The exact STC->FactorioLab
// modeling map and the spots where the two models are NOT cleanly equivalent
// are written up in ADAPTER-NOTES.md.

import type { RecipePack, Recipe as StcRecipe } from "@aef/schema";
import type { ItemTarget } from "../../src/data/targets";
import type { ItemOverride } from "../../src/data/plan";
import { effectiveSupply } from "../../src/solver/effectiveSupply";

import {
  AdjustedRecipe,
  RecipeJson,
  parseRecipe,
  finalizeRecipe,
} from "~/models/data/recipe";
import { ModuleEffect } from "~/models/data/module";
import { AdjustedDataset } from "~/models/dataset";
import { MaximizeType } from "~/models/enum/maximize-type";
import { ObjectiveType } from "~/models/enum/objective-type";
import { ObjectiveUnit } from "~/models/enum/objective-unit";
import { ObjectiveState } from "~/models/objective";
import { Rational, rational } from "~/models/rational";
import { CostSettings } from "~/models/settings/cost-settings";
import { Settings } from "~/models/settings/settings";

// The T1 gotcha: SimplexService.solve() unconditionally appends a
// `domain_key_tundra` Limit-0 objective and (in recipeMatches /
// itemAvailableIoRecipeIds) assumes the id exists as a boundary item in every
// dataset map. The id must therefore be present even on packs that never use
// it. The AEF pack already carries it as a raw item, but we still guarantee it.
export const DOMAIN_KEY_TUNDRA = "domain_key_tundra";

export interface AdapterInput {
  pack: RecipePack;
  targets: ItemTarget[];
  itemOverrides?: ItemOverride[];
}

export interface AdapterOutput {
  objectives: ObjectiveState[];
  settings: Settings;
  data: AdjustedDataset;
}

const noEffects: Record<ModuleEffect, Rational> = {
  consumption: rational.one,
  pollution: rational.one,
  productivity: rational.one,
  quality: rational.zero,
  speed: rational.one,
};

// Mirror of STC's recipeCostWeight (src/solver/lp.ts). We do NOT thread
// per-recipe cost overrides here (the prototype's headline plan has none); the
// uniform "normal = 1, big-M for the skip-by-default classes" profile is what
// STC's default objective minimizes, and it makes the FactorioLab recipe-var
// count (~ machine count) the dominant objective term (Tier-3 alignment).
function recipeCost(r: StcRecipe): number {
  if (r.flags?.includes("target-only")) return 1e6;
  if (r.cost === -1) return 1e6;
  if (r.category === "__domain_transfer") return 1e6;
  return 1;
}

// Build a FactorioLab AdjustedRecipe from an STC pack recipe. STC recipes carry
// `time` plus integer `in`/`out` stoich; FactorioLab's parseRecipe consumes the
// same RecipeJson shape, and finalizeRecipe derives `output` (the NET per-time
// production map) and `produces` (items the recipe nets positive) -- the exact
// fields the simplex reads. `consumption` is set so adjustPowerPollution runs.
function toAdjustedRecipe(r: StcRecipe): AdjustedRecipe {
  const json: RecipeJson = {
    id: r.id,
    name: r.name,
    category: r.category,
    row: r.row,
    time: r.time,
    producers: r.producers,
    in: Object.fromEntries(r.in.map((s) => [s.item, s.qty])),
    out: Object.fromEntries(r.out.map((s) => [s.item, s.qty])),
    cost: recipeCost(r),
  };
  const adjusted: AdjustedRecipe = {
    ...parseRecipe(json),
    // parseRecipe maps json.cost through rational(); re-assert it so a -1 STC
    // sentinel never leaks in as a negative objective coefficient.
    cost: rational(recipeCost(r)),
    consumption: rational(50n), // any nonzero value exercises the power path
    effects: { ...noEffects },
    produces: new Set<string>(),
    output: {},
  };
  finalizeRecipe(adjusted);
  return adjusted;
}

export function buildAdapterInput(input: AdapterInput): AdapterOutput {
  const { pack } = input;
  const overrides = input.itemOverrides ?? [];

  // 1. Effective supply per item -> which items are FactorioLab "no-recipe"
  //    (unproduceable = free boundary) items. STC treats effectiveSupply ===
  //    Infinity as an unbounded free source with no mass-balance constraint;
  //    FactorioLab models a free source as an item with no producing recipe.
  //    Items with a finite cap (override ratePerSec) stay producible but get an
  //    Input objective (capped free supply) added below.
  const freeItemIds = new Set<string>();
  const cappedSupply = new Map<string, Rational>();
  for (const it of pack.items) {
    const supply = effectiveSupply(it.id, pack, overrides);
    // effectiveSupply returns `Fraction | typeof Infinity`; `typeof Infinity`
    // is `number`, so narrow on the value type rather than `=== Infinity`.
    if (typeof supply === "number") {
      freeItemIds.add(it.id);
    } else {
      // Fraction; positive => finite external supply cap. Zero => no external
      // supply (build internally), which needs no Input objective. fraction.js
      // exposes bigint n/d/s.
      const num = supply.n * supply.s; // signed numerator (bigint)
      const den = supply.d; // bigint
      if (num > 0n) cappedSupply.set(it.id, new Rational(num, den));
    }
  }
  // The hardcoded boundary id must be a free no-recipe item regardless of pack.
  freeItemIds.add(DOMAIN_KEY_TUNDRA);

  // 2. Build the adjusted-recipe map + the producer/consumer index maps.
  const adjustedRecipe: Record<string, AdjustedRecipe> = {};
  for (const r of pack.recipes) adjustedRecipe[r.id] = toAdjustedRecipe(r);

  const itemIds = pack.items.map((i) => i.id);
  // Guarantee the hardcoded boundary item exists in the id list.
  if (!itemIds.includes(DOMAIN_KEY_TUNDRA)) itemIds.push(DOMAIN_KEY_TUNDRA);

  // itemRecipeIds: every recipe that nets the item positive (produces it).
  // itemAvailableRecipeIds: the subset FactorioLab is allowed to produce with.
  //   For a free item we omit ALL producers so the solver classes it
  //   unproduceable (a free boundary), matching STC's Infinity supply.
  // itemAvailableIoRecipeIds: producers + consumers (the "io" map the surplus
  //   path uses for net mass-balance). Free items still expose their consumers
  //   so a recipe can DRAW the free item; they just have no producer entry.
  const itemRecipeIds: Record<string, string[]> = {};
  const itemAvailableRecipeIds: Record<string, string[]> = {};
  const itemAvailableIoRecipeIds: Record<string, string[]> = {};
  for (const id of itemIds) {
    itemRecipeIds[id] = [];
    itemAvailableRecipeIds[id] = [];
    itemAvailableIoRecipeIds[id] = [];
  }

  for (const r of pack.recipes) {
    const adj = adjustedRecipe[r.id]!;
    // `produces` is the precise "nets positive" set from finalizeRecipe; use it
    // so a catalytic in==out item is not miscounted as a producer.
    for (const itemId of adj.produces) {
      itemRecipeIds[itemId]?.push(r.id);
      if (!freeItemIds.has(itemId)) itemAvailableRecipeIds[itemId]?.push(r.id);
    }
    // io map: any recipe touching the item (in OR out). `output[itemId]` exists
    // for every in/out item after finalizeRecipe.
    for (const itemId of Object.keys(adj.output)) {
      if (!itemAvailableIoRecipeIds[itemId]?.includes(r.id))
        itemAvailableIoRecipeIds[itemId]?.push(r.id);
    }
  }
  // Free items: drop producers from the io map too, so net mass balance never
  // credits an in-plan recipe with producing the free boundary item (STC leaves
  // free items entirely out of the mass-balance system).
  for (const id of freeItemIds) {
    if (itemAvailableIoRecipeIds[id]) {
      itemAvailableIoRecipeIds[id] = itemAvailableIoRecipeIds[id]!.filter(
        (rid) => {
          const adj = adjustedRecipe[rid]!;
          return !adj.produces.has(id);
        },
      );
    }
  }

  // 3. itemEntities: only `.stack` is read (fluid-cost-ratio gate). Mirror the
  //    pack: solids carry stack, fluids omit it. Stack value itself is unused
  //    once the `fluidCostRatio` flag is absent (we leave it absent).
  const itemEntities: Record<string, { id: string; stack?: Rational }> = {};
  for (const it of pack.items) {
    itemEntities[it.id] =
      it.stack != null
        ? { id: it.id, stack: rational(BigInt(it.stack)) }
        : { id: it.id };
  }
  if (!itemEntities[DOMAIN_KEY_TUNDRA])
    itemEntities[DOMAIN_KEY_TUNDRA] = {
      id: DOMAIN_KEY_TUNDRA,
      stack: rational.one,
    };

  const data = {
    flags: new Set<string>(), // no `fluidCostRatio`, no `inactiveDrain`
    itemIds,
    itemEntities,
    adjustedRecipe,
    itemRecipeIds,
    itemAvailableRecipeIds,
    itemAvailableIoRecipeIds,
  } as unknown as AdjustedDataset;

  // 4. Objectives.
  //    - Each STC target -> an item-Output objective on the target ITEM at
  //      `ratePerSec` items/sec. Targets are now item-shaped
  //      (`{itemId, ratePerSec}`) and STC's LP meets per-item demand
  //      (`demandByItem`) by picking producers on cost -- it no longer pins a
  //      specific target recipe. So the item-Output objective is now an exact
  //      mirror of STC's target handling (the old pin-recipe vs pin-item
  //      non-equivalence in ADAPTER-NOTES is gone: both solvers meet item
  //      demand and choose producers freely).
  //    - Each finite-cap itemOverride -> an Input objective (capped free input).
  const objectives: ObjectiveState[] = [];
  let oid = 0;
  for (const t of input.targets) {
    const value = new Rational(BigInt(t.ratePerSec.num), BigInt(t.ratePerSec.denom));
    objectives.push({
      id: String(oid++),
      targetId: t.itemId,
      unit: ObjectiveUnit.Items,
      type: ObjectiveType.Output,
      value,
    } as ObjectiveState);
  }
  for (const [itemId, cap] of cappedSupply) {
    objectives.push({
      id: String(oid++),
      targetId: itemId,
      unit: ObjectiveUnit.Items,
      type: ObjectiveType.Input,
      value: cap,
    } as ObjectiveState);
  }

  // 5. Costs + settings.
  //    Profile chosen so the recipe-var (machine) count dominates the objective:
  //      - recipe var cost = recipeCost() above (normal 1, big-M skip classes).
  //      - surplus: small positive, matching STC's SURPLUS_WEIGHT (1e-3). A
  //        positive surplus cost also flips FactorioLab onto the io-recipe maps
  //        for net balance, the closer analogue of STC's per-item equalities.
  //      - unproduceable: modest positive so drawing a free boundary item is
  //        cheap but not free (keeps the solver from gratuitously over-drawing;
  //        STC raw supply is strictly free, see ADAPTER-NOTES).
  //      - maximize: large negative (only matters for Maximize objectives, none
  //        here); factor/footprint/machine/excluded/recycling are inert for the
  //        objective set the adapter emits.
  const costs: CostSettings = {
    factor: rational.one,
    machine: rational.one,
    footprint: rational.zero,
    unproduceable: rational(1n, 1000n),
    excluded: rational.zero,
    surplus: rational(1n, 1000n),
    maximize: rational(-1000000n),
    recycling: rational.one,
  };

  const settings: Settings = {
    excludedItemIds: new Set<string>(),
    maximizeType: MaximizeType.Ratio,
    requireMachinesOutput: false,
    costs,
  };

  return { objectives, settings, data };
}
