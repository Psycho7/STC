// Boundary input topology: which cards an imported item gets.
//
// A container bucket earns its own card because an edge must enter a compound
// node once; consumers in no container share the item's single card and draw
// straight from it. These suites pin the three shapes that come out of that
// rule (loose only, containers only, mixed) and sweep the corpus for leftover
// per-consumer slice ids.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { pack } from "../../data/load";
import { withoutGasMachines } from "../../solver/closed-form-fixtures";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import { renderPlanFromSolve } from "../driver";
import { isInputProductUnit } from "../types";
import type { RenderPlan, RenderUnitInputProduct } from "../types";
import type { Target } from "../../data/targets";
import type { RecipePack } from "@aef/schema";
import { checkProductUnitRates } from "./invariants";
import { rationalFromString } from "./rational";
import { MULTI_TARGET_PLANS } from "./corpus-plans";

const RATE_ONE = { num: "1", denom: "1" } as const;

// game v1.4's gas machines reroute the xiranite chain, so the water fanout the
// aggregate fixture needs only forms on the pre-gas topology.
const legacyPack: RecipePack = withoutGasMachines(pack);

type SolvedPlan = {
  plan: RenderPlan;
  rates: ReadonlyMap<string, Fraction>;
  pack: RecipePack;
  targets: ReadonlyArray<Target>;
  itemOverrides: ReadonlyArray<never>;
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
  const full = solvePlanWithIntermediates(
    targets,
    packArg,
    defaultTransportConfig,
    [],
  );
  const { plan } = renderPlanFromSolve(full, packArg, targets, []);
  return {
    plan,
    rates: full.rates,
    pack: packArg,
    targets,
    itemOverrides: [],
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
    expect(inputs.map((u) => u.id)).toEqual([`u:in:${LOOSE_ONLY_ITEM}`]);

    const node = inputs[0]!;
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
    expect(new Set(outEdges.map((e) => e.toUnit)).size).toBe(outEdges.length);

    // Edge rates sum exactly to the card's rate.
    expect(sumRates(outEdges).equals(rationalFromString(node.rate))).toBe(true);
  });
});

describe("boundary inputs: containers keep their slice cards", () => {
  it("fans liquid_water out to per-container slices on the legacy pack", () => {
    const { plan } = renderPlanFor(["xiranite_enr_powder"], legacyPack);
    const inputs = inputsForItem(plan, "liquid_water");
    const aggregate = inputs.find((u) => u.isAggregate);
    expect(aggregate?.id).toBe("u:in:liquid_water");

    const slices = inputs.filter((u) => u.isFanout);
    expect(slices.length).toBeGreaterThan(0);
    for (const slice of slices) {
      expect(slice.parentRate).toEqual(aggregate!.rate);
      // Every slice is a container slice: its id is the aggregate id plus a
      // container segment, and the aggregate feeds it exactly once.
      expect(slice.id.startsWith("u:in:liquid_water:")).toBe(true);
      const inbound = plan.edges.filter(
        (e) => e.toUnit === slice.id && e.item === "liquid_water",
      );
      expect(inbound.map((e) => e.fromUnit)).toEqual(["u:in:liquid_water"]);
      expect(inbound[0]!.rate.equals(rationalFromString(slice.rate))).toBe(
        true,
      );
    }

    expect(plan.units.some((u) => u.id.includes(":tap:"))).toBe(false);
  });
});

// bottled_food_5 draws liquid_water into one container plus three loose
// consumers.
const MIXED_RECIPE = "bottled_food_5";
const MIXED_ITEM = "liquid_water";

describe("boundary inputs: container slices plus loose consumers", () => {
  it("hangs the loose consumers off the aggregate and balances its rate", () => {
    const { plan } = renderPlanFor([MIXED_RECIPE]);
    const inputs = inputsForItem(plan, MIXED_ITEM);
    const aggregate = inputs.find((u) => u.isAggregate);
    expect(aggregate?.id).toBe(`u:in:${MIXED_ITEM}`);

    const sliceIds = new Set(inputs.filter((u) => u.isFanout).map((u) => u.id));
    expect(sliceIds.size).toBeGreaterThan(0);
    // Every input card for the item is either the aggregate or a slice: the
    // loose bucket contributes none.
    expect(inputs.length).toBe(sliceIds.size + 1);

    const outEdges = edgesFrom(plan, aggregate!.id, MIXED_ITEM);
    const looseEdges = outEdges.filter((e) => !sliceIds.has(e.toUnit));
    expect(looseEdges.length).toBeGreaterThan(0);
    // Loose edges land on consumers, never on another input card.
    const inputIds = new Set(inputs.map((u) => u.id));
    expect(looseEdges.some((e) => inputIds.has(e.toUnit))).toBe(false);

    // Aggregate rate == sum(slice inbound) + sum(direct loose edges), exactly.
    expect(sumRates(outEdges).equals(rationalFromString(aggregate!.rate))).toBe(
      true,
    );
  });
});

describe("boundary inputs: corpus sweep", () => {
  it("mints no per-consumer slice ids and keeps every product rate clean", () => {
    const failures: string[] = [];

    const sweep = (name: string, targets: Target[]): void => {
      let full;
      try {
        full = solvePlanWithIntermediates(
          targets,
          pack,
          defaultTransportConfig,
          [],
        );
      } catch {
        return; // infeasible / unsolvable: not this suite's business
      }
      if (!full.feasibility.softFeasible) return;

      const { plan } = renderPlanFromSolve(full, pack, targets, []);
      for (const u of plan.units) {
        if (u.id.includes(":tap:")) failures.push(`${name}: tap id ${u.id}`);
      }
      const { violations } = checkProductUnitRates({
        plan,
        rates: full.rates,
        pack,
        targets,
        itemOverrides: [],
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
