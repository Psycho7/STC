// A cycled catalyst charge is drawn from a boundary node of its own,
// `u:cat:<item>`, never from the item's ordinary `u:in:<item>` node. The render
// plan carries one edge per (recipe unit, catalyst item) marked `toPortKind:
// "catalyst"`, all of them leaving the catalyst node, and that node's rate is
// the account's `need`. The draw is boundary supply no matter what the item is:
// raw or not, produced in-plan or not, capped or not.
//
// vitest runs with import.meta.env.DEV = true, so the render driver's
// invariant hook runs on every solve below; completing without a throw is
// itself an assertion that the checkers accept the catalyst edges.
import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";

import { pack } from "../../data/load";
import { solveForRender } from "../solveForRender";
import type { SolveForRenderOutput } from "../solveForRender";
import { checkRenderPlan } from "./invariants";
import { rationalFromString } from "./rational";
import { isInputProductUnit, isRecipeUnit } from "../types";
import type { RenderPlan, RenderEdge, RenderUnitInputProduct } from "../types";
import type { ItemTarget } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";

const GAS_XIRANITE = "gas_xiranite";
const LIQUID_XIRANITE = "liquid_xiranite";

function assertClean(out: SolveForRenderOutput): void {
  const violations = checkRenderPlan({
    plan: out.plan,
    rates: out.full.rates,
    pack: out.pack,
    targets: out.targets,
    itemOverrides: out.itemOverrides,
    catalystAccount: out.full.catalystAccount,
  }).flatMap((r) => r.violations);
  expect(violations).toEqual([]);
}

function catalystEdgesInto(plan: RenderPlan, unitId: string): RenderEdge[] {
  return plan.edges.filter(
    (e) => e.toUnit === unitId && e.toPortKind === "catalyst",
  );
}

function inputsForItem(
  plan: RenderPlan,
  itemId: string,
): RenderUnitInputProduct[] {
  return plan.units.filter(
    (u): u is RenderUnitInputProduct =>
      isInputProductUnit(u) && u.itemId === itemId,
  );
}

function unitRate(plan: RenderPlan, unitId: string): Fraction {
  const unit = plan.units.find((u) => u.id === unitId);
  expect(unit, `no unit ${unitId}`).toBeDefined();
  expect(isInputProductUnit(unit!)).toBe(true);
  return rationalFromString((unit as RenderUnitInputProduct).rate);
}

function sumRates(edges: ReadonlyArray<{ rate: Fraction }>): Fraction {
  return edges.reduce((acc, e) => acc.add(e.rate), new Fraction(0));
}

// Every catalyst edge in the plan, with the node it leaves.
function catalystEdges(plan: RenderPlan): RenderEdge[] {
  return plan.edges.filter((e) => e.toPortKind === "catalyst");
}

describe("catalyst supply edges", () => {
  // The worked example: gas_xiranite feeds equipment scripts as an ordinary
  // raw AND is cycled by every solid-gas transmuter the plan runs. The two
  // draws now sit on two nodes: 390/min ordinary on `u:in:`, the whole cycled
  // need on `u:cat:`.
  it("splits the worked example into an ordinary node and a catalyst node", () => {
    const targets: ItemTarget[] = [
      { itemId: "equip_script_4_3", ratePerSec: { num: "1", denom: "5" } },
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "2", denom: "5" } },
    ];
    const out = solveForRender({ targets });
    const { full, plan } = out;
    assertClean(out);

    expect(
      unitRate(plan, `u:in:${GAS_XIRANITE}`).equals(new Fraction(390, 60)),
    ).toBe(true);
    const need = full.catalystAccount.get(GAS_XIRANITE)!.need;
    expect(unitRate(plan, `u:cat:${GAS_XIRANITE}`).equals(need)).toBe(true);

    // Every catalyst edge in the plan leaves a catalyst node, and every
    // solid-gas transmuter unit draws its charge over one.
    for (const e of catalystEdges(plan)) {
      expect(e.fromUnit.startsWith("u:cat:"), e.fromUnit).toBe(true);
    }
    const transmuters = plan.units.filter(
      (u) => isRecipeUnit(u) && u.recipeId.startsWith("phase_trans_2-"),
    );
    expect(transmuters.length).toBeGreaterThan(0);
    for (const u of transmuters) {
      const cat = catalystEdgesInto(plan, u.id);
      expect(
        cat.map((e) => e.item),
        `unit ${u.id}`,
      ).toEqual([GAS_XIRANITE]);
      expect(cat[0]!.fromUnit).toBe(`u:cat:${GAS_XIRANITE}`);
    }
  }, 60000);

  // A catalyst rate is the stamp's per-machine charge, whatever the item's cap
  // or in-plan production says.
  it("sizes each catalyst edge at the stamp's per-machine charge", () => {
    const targets: ItemTarget[] = [
      { itemId: "liquid_copper", ratePerSec: { num: "1", denom: "1" } },
    ];
    const out = solveForRender({ targets });
    const { full, plan } = out;
    assertClean(out);

    const recipeId = "phase_trans_1-liquid_copper";
    const unit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === recipeId,
    );
    expect(unit).toBeDefined();
    const cat = catalystEdgesInto(plan, unit!.id);
    expect(cat.length).toBeGreaterThan(0);
    expect(cat.every((e) => e.item === LIQUID_XIRANITE)).toBe(true);
    // One whole transmuter, holding 0.2 per 2 s cycle: 1/10 per second, which
    // is the 6/min the pack declares per machine.
    expect(sumRates(cat).equals(new Fraction(1, 10))).toBe(true);
    expect(
      sumRates(cat).equals(full.catalystAccount.get(LIQUID_XIRANITE)!.need),
    ).toBe(true);
    // The consumer sits in a loop, and still draws from the item's one
    // catalyst card.
    for (const e of cat) {
      expect(e.fromUnit).toBe(`u:cat:${LIQUID_XIRANITE}`);
    }
  }, 60000);

  // liquid_xiranite is not raw and the plan builds it; the catalyst charge is
  // still boundary supply, and it is the ONLY draw, so the item has a catalyst
  // node and no ordinary node at all.
  it("gives a catalyst-only item a catalyst node and no ordinary node", () => {
    const targets: ItemTarget[] = [
      { itemId: LIQUID_XIRANITE, ratePerSec: { num: "1", denom: "1" } },
    ];
    const out = solveForRender({ targets });
    const { full, plan } = out;
    assertClean(out);

    const producer = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "phase_trans_1-liquid_xiranite",
    );
    expect(
      producer,
      "premise: the plan runs the self-cycling producer",
    ).toBeDefined();

    expect(inputsForItem(plan, LIQUID_XIRANITE).map((u) => u.id)).toEqual([
      `u:cat:${LIQUID_XIRANITE}`,
    ]);
    const catNode = inputsForItem(plan, LIQUID_XIRANITE)[0]!;
    expect(catNode.role).toBe("catalyst");

    const cat = catalystEdgesInto(plan, producer!.id);
    expect(cat.length).toBeGreaterThan(0);
    expect(cat.every((e) => e.fromUnit === `u:cat:${LIQUID_XIRANITE}`)).toBe(
      true,
    );
    expect(
      unitRate(plan, `u:cat:${LIQUID_XIRANITE}`).equals(
        full.catalystAccount.get(LIQUID_XIRANITE)!.need,
      ),
    ).toBe(true);
  }, 60000);

  // phase_trans_2-xiranite_powder lists gas_xiranite as both a consumed input
  // and a cycled catalyst: one ordinary bucket and one catalyst bucket, which
  // emit two single-bucket nodes rather than an aggregate with slices.
  it("emits two single-bucket nodes for one item carried as in and catalyst", () => {
    const targets: ItemTarget[] = [
      { itemId: "xiranite_powder", ratePerSec: { num: "1", denom: "1" } },
    ];
    // Steer the LP onto the transmuter route; the carbon routes are otherwise
    // cheaper and never touch a catalyst.
    const recipeCosts = new Map<string, number>(
      pack.recipes
        .filter(
          (r) =>
            r.out[0]?.item === "xiranite_powder" &&
            r.id !== "phase_trans_2-xiranite_powder",
        )
        .map((r) => [r.id, 1000]),
    );
    const out = solveForRender({ targets, recipeCosts });
    const { full, plan } = out;
    assertClean(out);

    const unit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "phase_trans_2-xiranite_powder",
    );
    expect(
      unit,
      "premise: the steer picked the transmuter route",
    ).toBeDefined();

    const nodes = inputsForItem(plan, GAS_XIRANITE);
    expect(nodes.map((u) => u.id).sort()).toEqual([
      `u:cat:${GAS_XIRANITE}`,
      `u:in:${GAS_XIRANITE}`,
    ]);

    const inbound = plan.edges.filter(
      (e) => e.toUnit === unit!.id && e.item === GAS_XIRANITE,
    );
    expect(inbound).toHaveLength(2);
    const ordinary = inbound.filter((e) => e.toPortKind === undefined);
    const cycled = inbound.filter((e) => e.toPortKind === "catalyst");
    expect(ordinary.map((e) => e.fromUnit)).toEqual([`u:in:${GAS_XIRANITE}`]);
    expect(cycled.map((e) => e.fromUnit)).toEqual([`u:cat:${GAS_XIRANITE}`]);

    // The ordinary node carries the consumed 1 per execution and nothing else;
    // the catalyst node carries the whole account need.
    const rate = full.rates.get("phase_trans_2-xiranite_powder")!;
    expect(unitRate(plan, `u:in:${GAS_XIRANITE}`).equals(rate)).toBe(true);
    expect(
      unitRate(plan, `u:cat:${GAS_XIRANITE}`).equals(
        full.catalystAccount.get(GAS_XIRANITE)!.need,
      ),
    ).toBe(true);
  }, 60000);

  // Two caps on one item, one per pool: each lands on its own node and neither
  // node's rate carries the other pool's draw.
  it("keeps the ordinary cap and the C-row cap on their own nodes", () => {
    const targets: ItemTarget[] = [
      { itemId: "xiranite_powder", ratePerSec: { num: "1", denom: "1" } },
    ];
    const recipeCosts = new Map<string, number>(
      pack.recipes
        .filter(
          (r) =>
            r.out[0]?.item === "xiranite_powder" &&
            r.id !== "phase_trans_2-xiranite_powder",
        )
        .map((r) => [r.id, 1000]),
    );
    // The ordinary cap sits above the ordinary demand so the solve is
    // untouched and the two rates stay readable.
    const itemOverrides: ItemOverride[] = [
      { itemId: GAS_XIRANITE, ratePerSec: { num: "10", denom: "1" } },
      {
        itemId: GAS_XIRANITE,
        role: "catalyst",
        ratePerSec: { num: "1", denom: "20" },
      },
    ];
    const out = solveForRender({ targets, recipeCosts, itemOverrides });
    const { full, plan } = out;
    assertClean(out);

    const ordinary = plan.units.find(
      (u): u is RenderUnitInputProduct => u.id === `u:in:${GAS_XIRANITE}`,
    )!;
    const cycled = plan.units.find(
      (u): u is RenderUnitInputProduct => u.id === `u:cat:${GAS_XIRANITE}`,
    )!;
    const rate = full.rates.get("phase_trans_2-xiranite_powder")!;
    expect(rationalFromString(ordinary.rate).equals(rate)).toBe(true);
    expect(ordinary.rateCap).toEqual({ num: "10", denom: "1" });
    expect(ordinary.role).toBeUndefined();
    expect(
      rationalFromString(cycled.rate).equals(
        full.catalystAccount.get(GAS_XIRANITE)!.need,
      ),
    ).toBe(true);
    expect(cycled.rateCap).toEqual({ num: "1", denom: "20" });
    expect(cycled.role).toBe("catalyst");
  }, 60000);

  // Catalyst consumers inside and outside a loop all draw from the item's one
  // catalyst card, which carries the item's whole need.
  it("draws a loop-spread catalyst item from one catalyst card", () => {
    const targets: ItemTarget[] = [
      { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
    ];
    // Off the smelted-nugget route the copper chain closes a loop, and the
    // transmuters inside that loop are catalyst consumers while the rest of the
    // plan's transmuters sit outside it: the shape that used to fan out.
    const recipeCosts = new Map<string, number>([["copper_nugget", 1000]]);
    const out = solveForRender({ targets, recipeCosts });
    const { full, plan } = out;
    assertClean(out);

    const nodes = inputsForItem(plan, LIQUID_XIRANITE).filter(
      (u) => u.role === "catalyst",
    );
    expect(nodes.map((u) => u.id)).toEqual([`u:cat:${LIQUID_XIRANITE}`]);
    const card = nodes[0]!;
    const need = full.catalystAccount.get(LIQUID_XIRANITE)!.need;
    expect(rationalFromString(card.rate).equals(need)).toBe(true);

    const own = plan.edges.filter(
      (e) => e.fromUnit === card.id && e.toPortKind === "catalyst",
    );
    expect(sumRates(own).equals(need)).toBe(true);
    const inLoop = new Set(
      plan.units
        .filter((u) => isRecipeUnit(u) && u.containerId !== undefined)
        .map((u) => u.id),
    );
    // Premise: the card feeds consumers on both sides of the loop line.
    expect(own.some((e) => inLoop.has(e.toUnit))).toBe(true);
    expect(own.some((e) => !inLoop.has(e.toUnit))).toBe(true);
  }, 60000);

  // `fromPool` marks the pool an edge LEAVES, which is what the dashed catalyst
  // stroke draws from. The loop-spread plan is the demanding case: the flag has
  // to reach every consumer edge of the catalyst card, inside the loop and out.
  it("stamps fromPool on every edge leaving the catalyst pool", () => {
    const targets: ItemTarget[] = [
      { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
    ];
    const recipeCosts = new Map<string, number>([["copper_nugget", 1000]]);
    const out = solveForRender({ targets, recipeCosts });
    const { plan } = out;
    assertClean(out);

    const fromCatalyst = plan.edges.filter((e) =>
      e.fromUnit.startsWith("u:cat:"),
    );
    expect(fromCatalyst.length).toBeGreaterThan(0);
    for (const e of fromCatalyst) {
      expect(e.fromPool, `${e.fromUnit} -> ${e.toUnit}`).toBe("catalyst");
    }
    for (const e of plan.edges.filter((x) => x.fromUnit.startsWith("u:in:"))) {
      expect(e.fromPool, `${e.fromUnit} -> ${e.toUnit}`).toBeUndefined();
    }
  }, 60000);

  // The fold key carries the source pool, so the two draws of one item into one
  // card -- raw on the in: row, cycled on the catalyst row -- survive the
  // aggregation as two edges with two stroke identities.
  it("keeps a raw draw and a catalyst draw of one item on one card apart", () => {
    const targets: ItemTarget[] = [
      { itemId: "xiranite_powder", ratePerSec: { num: "1", denom: "1" } },
    ];
    const recipeCosts = new Map<string, number>(
      pack.recipes
        .filter(
          (r) =>
            r.out[0]?.item === "xiranite_powder" &&
            r.id !== "phase_trans_2-xiranite_powder",
        )
        .map((r) => [r.id, 1000]),
    );
    const out = solveForRender({ targets, recipeCosts });
    const { plan } = out;
    assertClean(out);

    const unit = plan.units.find(
      (u) => isRecipeUnit(u) && u.recipeId === "phase_trans_2-xiranite_powder",
    )!;
    const inbound = plan.edges.filter(
      (e) => e.toUnit === unit.id && e.item === GAS_XIRANITE,
    );
    expect(inbound).toHaveLength(2);
    expect(inbound.map((e) => e.fromPool).sort()).toEqual([
      "catalyst",
      undefined,
    ]);
  }, 60000);
});
