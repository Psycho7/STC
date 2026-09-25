// Boundary input topology: which cards an imported item gets.
//
// Every consumer shares the item's single card per pool and draws straight
// from it, a loop member included: a loop is no compound node, so no edge has
// to enter one once. These suites pin that shape on a plan with no loop, on a
// plan whose consumers all sit in loops, and on a mixed plan, and sweep the
// corpus for leftover per-consumer slice ids.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { pack } from "../../data/load";
import { withoutGasMachines } from "../../solver/closed-form-fixtures";
import { solveForRender } from "../solveForRender";
import { isInputProductUnit } from "../types";
import type { RenderPlan, RenderUnitInputProduct } from "../types";
import type { Target } from "../../data/targets";
import type { RecipePack } from "@aef/schema";
import type { CatalystAccount } from "../../solver/catalyst";
import { checkProductUnitRates } from "./invariants";
import { rationalFromString } from "./rational";
import { MULTI_TARGET_PLANS } from "./corpus-plans";

const RATE_ONE = { num: "1", denom: "1" } as const;

// game v1.4's gas machines reroute the xiranite chain, so the loop-fed water
// draw this fixture needs only forms on the pre-gas topology.
const legacyPack: RecipePack = withoutGasMachines(pack);

type SolvedPlan = {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<Target>;
  itemOverrides: ReadonlyArray<never>;
  catalystAccount: CatalystAccount;
};

// Solve the first output item of each named recipe at 1/sec and render it.
function renderPlanFor(
  recipeIds: ReadonlyArray<string>,
  packArg: RecipePack = pack,
): SolvedPlan {
  const targets: Target[] = recipeIds.map((recipeId) => ({
    itemId: packArg.recipes.find((r) => r.id === recipeId)!.out[0]!.item,
    ratePerSec: RATE_ONE,
  }));
  const { full, plan } = solveForRender({ targets, pack: packArg });
  return {
    plan,
    rates: full.rates,
    pack: packArg,
    targets,
    itemOverrides: [],
    catalystAccount: full.catalystAccount,
  };
}

const inputsForItem = (
  plan: RenderPlan,
  itemId: string,
): RenderUnitInputProduct[] =>
  plan.units.filter(isInputProductUnit).filter((u) => u.itemId === itemId);

const edgesFrom = (plan: RenderPlan, fromUnit: string, itemId: string) =>
  plan.edges.filter((e) => e.fromUnit === fromUnit && e.item === itemId);

const sumRates = (edges: ReadonlyArray<{ rate: Fraction }>): Fraction =>
  edges.reduce((acc, e) => acc.add(e.rate), new Fraction(0));

// equip_script_4_3 draws gas_xiranite into seven recipes, none of them inside a
// container: the shape the per-consumer tap cards used to blow up on.
const LOOSE_ONLY_RECIPE = "equip_script_4_3";
const LOOSE_ONLY_ITEM = "gas_xiranite";

describe("boundary inputs: loose consumers share one card", () => {
  it("emits a single plain input card feeding every loose consumer", () => {
    const { plan } = renderPlanFor([LOOSE_ONLY_RECIPE]);
    const inputs = inputsForItem(plan, LOOSE_ONLY_ITEM);
    // Two pools, one bucket each: the ordinary reagent draw and the cycled
    // catalyst charge, neither of them an aggregate.
    expect(inputs.map((u) => u.id).sort()).toEqual([
      `u:cat:${LOOSE_ONLY_ITEM}`,
      `u:in:${LOOSE_ONLY_ITEM}`,
    ]);

    const node = inputs.find((u) => u.id === `u:in:${LOOSE_ONLY_ITEM}`)!;
    expect(node.isAggregate).toBeUndefined();
    expect(node.isFanout).toBeUndefined();
    expect(node.parentRate).toBeUndefined();

    // One direct edge per consumer, and no edge lands on another input card.
    const outEdges = edgesFrom(plan, node.id, LOOSE_ONLY_ITEM);
    expect(outEdges.length).toBeGreaterThanOrEqual(3);
    const inputIds = new Set(
      plan.units.filter(isInputProductUnit).map((u) => u.id),
    );
    expect(outEdges.some((e) => inputIds.has(e.toUnit))).toBe(false);
    expect(
      new Set(outEdges.map((e) => `${e.toUnit}\0${e.toPortKind ?? "in"}`)).size,
    ).toBe(outEdges.length);

    // Edge rates sum exactly to the card's rate.
    expect(sumRates(outEdges).equals(rationalFromString(node.rate))).toBe(true);
  });
});

describe("boundary inputs: loop members draw from the item's one card", () => {
  it("feeds liquid_water to its loop consumers straight from u:in on the legacy pack", () => {
    const { plan } = renderPlanFor(["xiranite_enr_powder"], legacyPack);
    // Premise: the consumers sit in loops, which used to mint a slice each.
    expect(plan.containers.length).toBeGreaterThan(0);
    const inputs = inputsForItem(plan, "liquid_water");
    expect(inputs.map((u) => u.id)).toEqual(["u:in:liquid_water"]);
    const card = inputs[0]!;
    expect(card.isAggregate).toBeUndefined();
    expect(card.isFanout).toBeUndefined();
    expect(card.parentRate).toBeUndefined();

    const outEdges = edgesFrom(plan, card.id, "liquid_water");
    const consumers = new Set(
      plan.units
        .filter((u) => u.kind === "recipe" && u.containerId !== undefined)
        .map((u) => u.id),
    );
    expect(outEdges.some((e) => consumers.has(e.toUnit))).toBe(true);
    expect(sumRates(outEdges).equals(rationalFromString(card.rate))).toBe(true);
    expect(plan.units.some((u) => u.id.includes(":tap:"))).toBe(false);
  });
});

// bottled_food_5 draws liquid_water into one loop plus three loose consumers.
const MIXED_RECIPE = "bottled_food_5";
const MIXED_ITEM = "liquid_water";

describe("boundary inputs: loop and loose consumers share one card", () => {
  it("draws every consumer straight from the card and balances its rate", () => {
    const { plan } = renderPlanFor([MIXED_RECIPE]);
    const inputs = inputsForItem(plan, MIXED_ITEM);
    expect(inputs.map((u) => u.id)).toEqual([`u:in:${MIXED_ITEM}`]);
    const card = inputs[0]!;
    expect(card.isAggregate).toBeUndefined();

    const outEdges = edgesFrom(plan, card.id, MIXED_ITEM);
    const inLoop = new Set(
      plan.units
        .filter((u) => u.kind === "recipe" && u.containerId !== undefined)
        .map((u) => u.id),
    );
    // Both kinds of consumer hang off the one card.
    expect(outEdges.some((e) => inLoop.has(e.toUnit))).toBe(true);
    expect(outEdges.some((e) => !inLoop.has(e.toUnit))).toBe(true);
    // Every edge lands on a consumer, never on another input card.
    const inputIds = new Set(
      plan.units.filter(isInputProductUnit).map((u) => u.id),
    );
    expect(outEdges.some((e) => inputIds.has(e.toUnit))).toBe(false);

    // Card rate == sum of its edges, exactly.
    expect(sumRates(outEdges).equals(rationalFromString(card.rate))).toBe(true);
  });
});

// assertSolvable throws "LP solver: infeasible problem" / "LP solver:
// unbounded objective" (src/solver/index.ts) when the plan has no solution at
// all; every other throw out of the solve+render chain is a DEV invariant
// assertion.
function isLpThrow(err: unknown): boolean {
  return String(err).includes("LP solver:");
}

describe("boundary inputs: corpus sweep", () => {
  it("mints no per-consumer slice ids and keeps every product rate clean", () => {
    const failures: string[] = [];

    const sweep = (name: string, targets: Target[]): void => {
      let out;
      try {
        out = solveForRender({ targets, pack });
      } catch (err) {
        // Infeasible / unsolvable: not this suite's business. Anything else
        // (a DEV invariant assertion from either half) still rides out, the
        // way a render throw always has.
        if (!isLpThrow(err)) throw err;
        return;
      }
      if (!out.full.feasibility.softFeasible) return;

      const { full, plan } = out;
      for (const u of plan.units) {
        if (u.id.includes(":tap:")) failures.push(`${name}: tap id ${u.id}`);
      }
      const { violations } = checkProductUnitRates({
        plan,
        rates: full.rates,
        pack,
        targets,
        itemOverrides: [],
        catalystAccount: full.catalystAccount,
      });
      for (const v of violations) {
        failures.push(`${name}: ${v}`);
      }
    };

    for (const r of pack.recipes) {
      const itemId = r.out[0]?.item;
      if (itemId === undefined || itemId === "") continue;
      sweep(r.id, [{ itemId, ratePerSec: RATE_ONE }]);
    }

    for (const mt of MULTI_TARGET_PLANS) {
      const targets: Target[] = [];
      for (const recipeId of mt.recipeIds) {
        const itemId = pack.recipes.find((r) => r.id === recipeId)?.out[0]
          ?.item;
        if (itemId === undefined || itemId === "") continue;
        targets.push({ itemId, ratePerSec: RATE_ONE });
      }
      if (targets.length !== mt.recipeIds.length) continue;
      sweep(mt.name, targets);
    }

    expect(failures).toEqual([]);
  }, 120000);
});
