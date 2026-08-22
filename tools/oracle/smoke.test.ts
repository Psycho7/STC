import { loadModule } from 'glpk-ts';
import { beforeAll, expect, test } from 'vitest';

import { SimplexService } from '~/services/simplex.service';
import {
  AdjustedRecipe,
  parseRecipe,
  RecipeJson,
  finalizeRecipe,
} from '~/models/data/recipe';
import { ModuleEffect } from '~/models/data/module';
import { AdjustedDataset } from '~/models/dataset';
import { MaximizeType } from '~/models/enum/maximize-type';
import { ObjectiveType } from '~/models/enum/objective-type';
import { ObjectiveUnit } from '~/models/enum/objective-unit';
import { SimplexResultType } from '~/models/enum/simplex-result-type';
import { ObjectiveState } from '~/models/objective';
import { Rational, rational } from '~/models/rational';
import { CostSettings } from '~/models/settings/cost-settings';
import { Settings } from '~/models/settings/settings';

// glpk-ts must have its WASM module loaded before any Model is constructed.
// Mirror /tmp/flab-oracle/src/test.ts: load once via the real wasm path.
beforeAll(async () => {
  await loadModule('node_modules/glpk-wasm/dist/glpk.all.wasm');
});

const noEffects: Record<ModuleEffect, Rational> = {
  consumption: rational.one,
  pollution: rational.one,
  productivity: rational.one,
  quality: rational.zero,
  speed: rational.one,
};

function buildAdjustedRecipe(json: RecipeJson): AdjustedRecipe {
  const base = parseRecipe(json);
  const adjusted: AdjustedRecipe = {
    ...base,
    effects: { ...noEffects },
    produces: new Set<string>(),
    output: {},
  };
  finalizeRecipe(adjusted);
  return adjusted;
}

test('solves a trivial 2-recipe acyclic chain with the known closed-form answer', async () => {
  // Chain: raw --recipe_b--> mid --recipe_a--> final
  //   recipe_b: 1 raw -> 1 mid   (time 1)
  //   recipe_a: 1 mid -> 1 final (time 1)
  // `raw` has no producer (boundary / unproduceable).
  // Target: output 2 final/sec.
  // Closed form (flow conservation, time=1, 1:1 ratios):
  //   recipe_a machines = 2, recipe_b machines = 2.
  const recipeA = buildAdjustedRecipe({
    id: 'recipe_a',
    name: 'Recipe A',
    category: 'cat',
    row: 0,
    time: 1,
    producers: ['machine_a'],
    in: { mid: 1 },
    out: { final: 1 },
    cost: 1,
  });
  const recipeB = buildAdjustedRecipe({
    id: 'recipe_b',
    name: 'Recipe B',
    category: 'cat',
    row: 0,
    time: 1,
    producers: ['machine_b'],
    in: { raw: 1 },
    out: { mid: 1 },
    cost: 1,
  });

  // adjustPowerPollution reads recipe.consumption; set it so the real power
  // path is exercised (not just skipped).
  recipeA.consumption = rational(10n);
  recipeB.consumption = rational(10n);

  const adjustedRecipe = { recipe_a: recipeA, recipe_b: recipeB };

  // Only the read-slice fields the solver touches are populated; the rest of
  // the Dataset shape is filled with empty stubs.
  // NOTE: SimplexService.solve() hardcodes a `domain_key_tundra` Limit objective
  // (a fork region-transfer hack). It must therefore exist in the dataset maps as
  // a boundary item with no producing recipe.
  const data = {
    flags: new Set<string>(),
    itemIds: ['final', 'mid', 'raw', 'domain_key_tundra'],
    itemEntities: {
      final: { id: 'final', stack: rational.one },
      mid: { id: 'mid', stack: rational.one },
      raw: { id: 'raw', stack: rational.one },
      domain_key_tundra: { id: 'domain_key_tundra', stack: rational.one },
    },
    adjustedRecipe,
    itemRecipeIds: {
      final: ['recipe_a'],
      mid: ['recipe_b'],
      raw: [],
      domain_key_tundra: [],
    },
    itemAvailableRecipeIds: {
      final: ['recipe_a'],
      mid: ['recipe_b'],
      raw: [],
      domain_key_tundra: [],
    },
    itemAvailableIoRecipeIds: {
      final: ['recipe_a'],
      mid: ['recipe_a', 'recipe_b'],
      raw: ['recipe_b'],
      domain_key_tundra: [],
    },
  } as unknown as AdjustedDataset;

  const costs: CostSettings = {
    factor: rational.one,
    machine: rational.one,
    footprint: rational.one,
    unproduceable: rational(1000000n),
    excluded: rational(0n),
    surplus: rational.zero,
    maximize: rational(-1000000n),
    recycling: rational(1000n),
  };

  const settings: Settings = {
    excludedItemIds: new Set<string>(),
    maximizeType: MaximizeType.Ratio,
    requireMachinesOutput: false,
    costs,
  };

  const objectives: ObjectiveState[] = [
    {
      id: '0',
      targetId: 'final',
      unit: ObjectiveUnit.Items,
      type: ObjectiveType.Output,
      value: rational(2n),
    } as ObjectiveState,
  ];

  const service = new SimplexService();
  const result = service.solve(objectives, settings, data, false);

  expect(result.resultType).toBe(SimplexResultType.Solved);

  const machinesByRecipe = new Map<string, Rational>();
  for (const step of result.steps) {
    if (step.recipeId != null && step.machines != null) {
      machinesByRecipe.set(step.recipeId, step.machines);
    }
  }

  // Tier-2 exact rate assertion: closed-form machine counts.
  expect(machinesByRecipe.get('recipe_a')?.eq(rational(2n))).toBe(true);
  expect(machinesByRecipe.get('recipe_b')?.eq(rational(2n))).toBe(true);

  // Verify adjustPowerPollution actually ran: power = machines * consumption.
  const stepA = result.steps.find((s) => s.recipeId === 'recipe_a');
  expect(stepA?.power?.eq(rational(20n))).toBe(true);
});
