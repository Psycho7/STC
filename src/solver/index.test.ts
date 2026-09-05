import { describe, expect, it, vi } from "vitest";
import Fraction from "fraction.js";
import { LpInfeasibleError, solvePlanWithIntermediates } from "./index";
import {
  splitTargetProducers,
  coProductTarget,
  dualTargetItemsOneRecipe,
} from "./corpus";
import { renderPlanFromSolve } from "../pipeline/driver";
import { checkRenderPlan } from "../pipeline/render/invariants";
import { withoutGasMachines } from "./closed-form-fixtures";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { ItemTarget } from "../data/targets";
import type { RecipePack } from "@aef/schema";
import type { LpResult } from "./lp";

// game v1.4's gas-system machines let the LP route xiranite_enr_powder through
// a gas chain, displacing the water-fed main+purifier producers. The
// two-producer coexistence witness below solves against a pack without the
// gas-machine recipes to keep that plan (upstream recipes are unchanged).
const legacyPack: RecipePack = withoutGasMachines(pack);

// Force a specific LpResult.status for the infeasible/unbounded throw-arm tests.
// The LP model puts deficit+surplus slack on every finite-supply item, so the
// raw solver is always feasible for real recipe-pack data; "infeasible" and
// "unbounded" are unreachable through the public API with real packs. The flag
// overrides solveLp's status on the real entry points while every other test
// keeps using the real solver.
const lpStatusOverride = vi.hoisted(() => ({
  status: undefined as LpResult["status"] | undefined,
}));

vi.mock("./lp", async () => {
  const actual = await vi.importActual<typeof import("./lp")>("./lp");
  return {
    ...actual,
    solveLp: (input: Parameters<typeof actual.solveLp>[0]): LpResult => {
      const result = actual.solveLp(input);
      if (lpStatusOverride.status !== undefined) {
        return { ...result, status: lpStatusOverride.status };
      }
      return result;
    },
  };
});

describe("solvePlanWithIntermediates (LP)", () => {
  it("includes both purifier producers in the rate map", () => {
    const targets: ItemTarget[] = [
      {
        itemId: "xiranite_enr_powder",
        ratePerSec: { num: "6", denom: "60" },
      },
    ];
    // legacyPack: on the full v1.4 pack the gas route displaces both producers.
    const full = solvePlanWithIntermediates(
      targets,
      legacyPack,
      defaultTransportConfig,
    );
    expect(full.rates.get("liquid_xiranite_poly")).toBeDefined();
    expect(full.rates.get("liquid_xiranite_poly-purifier")).toBeDefined();
    expect(full.logical.nodes.length).toBeGreaterThan(0);
  });
});

describe("solver status handling", () => {
  // (b) Empty-but-feasible: a non-empty targets input whose optimum runs zero
  // recipes. The only producer of "prod" (zero_out) emits it at qty 0, so the
  // demand for "prod" becomes pure deficit and no x_recipe runs positive,
  // giving status "empty" with empty rates.
  // Must not throw: an empty-but-feasible optimum is a legitimate result.
  const emptyFeasiblePack = {
    recipes: [
      {
        id: "zero_out",
        category: "material",
        time: 1,
        in: [{ item: "raw_a", qty: 1 }],
        out: [{ item: "prod", qty: 0 }],
      },
    ],
    machines: [],
    items: [
      { id: "raw_a", raw: true },
      { id: "prod", raw: false },
    ],
  } as unknown as RecipePack;
  const emptyFeasibleTargets: ItemTarget[] = [
    { itemId: "prod", ratePerSec: { num: "1", denom: "1" } },
  ];

  it("does not throw on an empty-but-feasible optimum (solvePlanWithIntermediates)", () => {
    const full = solvePlanWithIntermediates(
      emptyFeasibleTargets,
      emptyFeasiblePack,
      defaultTransportConfig,
    );
    expect(full.rates.size).toBe(0);
    expect(full.logical.nodes.length).toBe(0);
  });

  // (a) Infeasible: status "infeasible" is unreachable through the public API
  // with real packs (universal slack, see the override note above), so the flag
  // forces solveLp's status. The entry point must surface it as a throw whose
  // message matches /infeasible/.
  const targets: ItemTarget[] = [
    {
      itemId: "xiranite_enr_powder",
      ratePerSec: { num: "6", denom: "60" },
    },
  ];

  it("throws on infeasible status", () => {
    lpStatusOverride.status = "infeasible";
    try {
      expect(() =>
        solvePlanWithIntermediates(targets, pack, defaultTransportConfig),
      ).toThrow(/infeasible/);
    } finally {
      lpStatusOverride.status = undefined;
    }
  });

  // The infeasible error carries the implicated ids (no UI strings): the finite
  // supply caps in the model plus the target outputs, so the UI can name the
  // offending item(s) without rebuilding solver diagnostics.
  it("infeasible error names the capped supply item and target output", () => {
    lpStatusOverride.status = "infeasible";
    const overrides = [
      { itemId: "liquid_water", ratePerSec: { num: "0", denom: "1" } },
    ];
    try {
      let caught: unknown;
      try {
        solvePlanWithIntermediates(
          targets,
          pack,
          defaultTransportConfig,
          overrides,
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LpInfeasibleError);
      const err = caught as LpInfeasibleError;
      expect(err.cappedItemIds).toContain("liquid_water");
      // xiranite_enr_powder's primary output is the implicated target item.
      expect(err.targetItemIds).toContain("xiranite_enr_powder");
    } finally {
      lpStatusOverride.status = undefined;
    }
  });
});

describe("multi-producer input of a split SCC member (assemble re-route)", () => {
  // Synthetic SCC fixture: members A+B loop on loop_m/loop_t; A is LP-zeroed
  // (its scarce input is capped to 0), so B's looper stamp gets rate 0 and the
  // external producers of B's inputs hang off the split stamps. Item x has TWO
  // producers: P1 is capped to 1/2 via raw1 and P2 covers the other 1/2. The
  // re-route used to drop every producer after the first, leaving P2's node
  // edgeless while B's full x demand was billed to P1.
  //
  // P2 carries a cost of 2 so the 1/2-1/2 split is unique-optimal: the LP
  // prefers the cheaper P1 up to its raw1 cap and P2 carries only the residual.
  // Without the asymmetry the bounded-draw formulation makes the raw1 draw
  // optional and the split degenerate, and the test could silently stop
  // exercising the multi-producer path.
  const mkPack = (
    recipes: object[],
    items: object[],
  ): RecipePack =>
    ({
      recipes: recipes.map((r) => ({ producers: ["m"], ...r })),
      items: items.map((i) => ({ transportKind: "belt", ...i })),
      machines: [{ id: "m", speed: 1 }],
    }) as unknown as RecipePack;
  const sccPack = mkPack(
    [
      {
        id: "tgt",
        category: "material",
        time: 1,
        in: [{ item: "out_b", qty: 1 }],
        out: [{ item: "final", qty: 1 }],
      },
      {
        id: "B",
        category: "material",
        time: 1,
        in: [
          { item: "x", qty: 1 },
          { item: "loop_t", qty: 1 },
        ],
        out: [
          { item: "out_b", qty: 1 },
          { item: "loop_m", qty: 1 },
        ],
      },
      {
        id: "A",
        category: "material",
        time: 1,
        in: [
          { item: "loop_m", qty: 1 },
          { item: "scarce", qty: 1 },
        ],
        out: [{ item: "loop_t", qty: 1 }],
      },
      {
        id: "E",
        category: "material",
        time: 1,
        in: [{ item: "raw_e", qty: 1 }],
        out: [{ item: "loop_t", qty: 1 }],
      },
      {
        id: "P1",
        category: "material",
        time: 1,
        in: [{ item: "raw1", qty: 1 }],
        out: [{ item: "x", qty: 1 }],
      },
      {
        id: "P2",
        category: "material",
        time: 1,
        in: [{ item: "raw2", qty: 1 }],
        out: [{ item: "x", qty: 1 }],
      },
    ],
    [
      { id: "final", raw: false },
      { id: "out_b", raw: false },
      { id: "x", raw: false },
      { id: "loop_t", raw: false },
      { id: "loop_m", raw: false },
      { id: "scarce", raw: true },
      { id: "raw_e", raw: true },
      { id: "raw1", raw: true },
      { id: "raw2", raw: true },
    ],
  );
  const sccTargets: ItemTarget[] = [
    { itemId: "final", ratePerSec: { num: "1", denom: "1" } },
  ];
  const sccOverrides = [
    { itemId: "scarce", ratePerSec: { num: "0", denom: "1" } },
    { itemId: "raw1", ratePerSec: { num: "1", denom: "2" } },
  ];
  const sccCosts = new Map([["P2", 2]]);

  it("wires BOTH x producers to the surviving B stamp; no surviving node is edgeless", () => {
    const full = solvePlanWithIntermediates(
      sccTargets,
      sccPack,
      defaultTransportConfig,
      sccOverrides,
      sccCosts,
    );
    const logical = full.logical;
    // Both producers run at 1/2.
    expect(full.rates.get("P1")?.equals(new Fraction(1, 2))).toBe(true);
    expect(full.rates.get("P2")?.equals(new Fraction(1, 2))).toBe(true);

    // Every surviving recipe node has at least one incident edge.
    const touched = new Set<string>();
    for (const e of logical.edges) {
      touched.add(e.source);
      touched.add(e.target);
    }
    const nodeRecipe = new Map(
      logical.nodes
        .filter((n) => n.kind === "recipe")
        .map((n) => [n.id, (n as { recipe: { id: string } }).recipe.id]),
    );
    for (const [id, rid] of nodeRecipe) {
      expect(touched.has(id), `node ${id} (${rid}) has no edges`).toBe(true);
    }

    // Both P1 and P2 ship x to a surviving B stamp.
    const xSources = new Set(
      logical.edges
        .filter(
          (e) => e.sourcePort === "out:x" && nodeRecipe.get(e.target) === "B",
        )
        .map((e) => nodeRecipe.get(e.source)),
    );
    expect(xSources).toEqual(new Set(["P1", "P2"]));
  });
});

describe("torn feedback covers every intra-SCC logical cycle", () => {
  // Regression: the old tear picked the min-qty edge of each back edge's
  // fundamental cycle instead of the back edge itself, so chords through the
  // back edge's endpoints survived untorn. On proc_battery_5 the 4-member
  // xiranite SCC kept a full directed 3-cycle (xiranite_poly ->
  // liquid_xiranite_poly -> liquid_xiranite_poly-purifier -> xiranite_poly)
  // in the assembled graph as plain (non-return) edges.
  it("proc_battery_5: non-return intra-SCC logical edges are acyclic", () => {
    const targets: ItemTarget[] = [
      {
        itemId: "proc_battery_5",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const recipeOfReplica = new Map(
      full.replicas.map((r) => [r.id, r.recipeId]),
    );

    let multiSccs = 0;
    for (const scc of full.condensation.sccs) {
      if (scc.recipeIds.length < 2) continue;
      multiSccs++;
      const members = new Set<string>(scc.recipeIds);
      // Project non-return logical edges between member replicas onto recipe
      // ids; post-fix this is a subgraph of the untorn intra-SCC recipe graph,
      // so it must be acyclic.
      const out = new Map<string, string[]>();
      for (const m of scc.recipeIds) out.set(m, []);
      for (const e of full.logical.edges) {
        if (e.id.includes("->return->")) continue;
        const src = recipeOfReplica.get(e.source);
        const tgt = recipeOfReplica.get(e.target);
        if (src === undefined || tgt === undefined) continue;
        if (!members.has(src) || !members.has(tgt)) continue;
        out.get(src)!.push(tgt);
      }

      // Iterative three-color DFS cycle check over the projection.
      const color = new Map<string, number>();
      for (const m of scc.recipeIds) color.set(m, 0);
      let cyclic = false;
      for (const start of scc.recipeIds) {
        if (color.get(start) !== 0) continue;
        const stack: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
        color.set(start, 1);
        while (stack.length && !cyclic) {
          const f = stack[stack.length - 1]!;
          const nbrs = out.get(f.v) ?? [];
          if (f.i >= nbrs.length) {
            color.set(f.v, 2);
            stack.pop();
            continue;
          }
          const w = nbrs[f.i++]!;
          if (color.get(w) === 1) cyclic = true;
          else if (color.get(w) === 0) {
            color.set(w, 1);
            stack.push({ v: w, i: 0 });
          }
        }
      }
      expect(cyclic, `SCC ${scc.id} keeps an untorn logical cycle`).toBe(false);
    }
    expect(multiSccs).toBeGreaterThan(0);
  });
});

describe("replica coverage of the LP solution", () => {
  // Regression: the triple-target plan used to carry a dangling crystal chain
  // at 1/900900 in the rates map; replication is demand-driven and correctly
  // minted zero replicas for it, leaving positive-rate recipes with no
  // machines. The extraction sweep now removes the chain, so every surviving
  // rate must be fully covered by replicas.
  //
  // Plan scale, derived: pin floors are 1 for all three targets (primary out
  // qty 1, rate 1/s); per-item demand is liquid_xiranite_poly = 2 (both
  // xiranite recipes share that primary item) and equip_script_4 = 1; so
  // planScale = max(1, floors, demands) = 2. The sweep ceiling is
  // 1e-4 * planScale; the phantom pair at 1/900900 (~1.11e-6) sits below the
  // ceiling for ANY planScale >= 1, so removal does not depend on the
  // shared-primary coincidence raising planScale to 2.
  it("triple-target xiranite plan: replica rate sums equal every LP rate", () => {
    // The duplicate liquid_xiranite_poly targets are deliberate: the solver
    // aggregates per-item demand below the validatePlan duplicate gate, and the
    // pair preserves the old two-recipes-same-primary shape of this fixture.
    const targets: ItemTarget[] = [
      {
        itemId: "liquid_xiranite_poly",
        ratePerSec: { num: "1", denom: "1" },
      },
      {
        itemId: "liquid_xiranite_poly",
        ratePerSec: { num: "1", denom: "1" },
      },
      {
        itemId: "equip_script_4",
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );

    const zero = new Fraction(0);
    const sums = new Map<string, Fraction>();
    for (const rep of full.replicas) {
      sums.set(
        rep.recipeId,
        (sums.get(rep.recipeId) ?? zero).add(rep.executionRate),
      );
    }
    const relTol = new Fraction(1, 1000000000000);
    for (const [recipeId, lpRate] of full.rates) {
      const sum = sums.get(recipeId) ?? zero;
      const diff = sum.sub(lpRate).abs();
      const scale = lpRate.abs().compare(1) > 0 ? lpRate.abs() : new Fraction(1);
      expect(
        diff.div(scale).compare(relTol) <= 0,
        `recipe ${recipeId}: replica sum ${sum.toFraction()} != lp ${lpRate.toFraction()}`,
      ).toBe(true);
    }
    for (const [recipeId, sum] of sums) {
      if (!full.rates.has(recipeId)) {
        expect(
          sum.equals(0),
          `replicas exist for ${recipeId} with no LP rate`,
        ).toBe(true);
      }
    }
  });
});

describe("LP-split target item through replicate and render", () => {
  // Scenario 16: the "gold" demand of 5/s is split across r_cheap (capped by
  // its vein input, out qty 1) and r_dear (out qty 3). Hand-derived:
  // r_cheap = 1 exec/s (vein cap, flow 1), r_dear = 4/3 exec/s (flow 4), and
  // the declared draw is apportioned 1 : 4 by production share, so the target
  // output unit receives exactly 1/s from r_cheap and 4/s from r_dear.
  it("replicates both producers and feeds the target output the declared rate", () => {
    const { pack: p, targets, itemOverrides, recipeCosts } =
      splitTargetProducers;
    const full = solvePlanWithIntermediates(
      targets,
      p,
      defaultTransportConfig,
      itemOverrides,
      recipeCosts,
    );

    // (a) Both producers replicate at their full LP rates.
    const zero = new Fraction(0);
    const sumOf = (rid: string) =>
      full.replicas
        .filter((r) => r.recipeId === rid)
        .reduce((acc, r) => acc.add(r.executionRate), zero);
    expect(full.rates.get("r_cheap")!.equals(1)).toBe(true);
    expect(full.rates.get("r_dear")!.equals(new Fraction(4, 3))).toBe(true);
    expect(sumOf("r_cheap").equals(1)).toBe(true);
    expect(sumOf("r_dear").equals(new Fraction(4, 3))).toBe(true);

    // (c) The render pipeline completes under the DEV invariant hooks and
    // every render checker reports zero violations.
    const { plan } = renderPlanFromSolve(full, p, targets, itemOverrides);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack: p,
      targets,
      itemOverrides,
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);

    // (b)+(d) The synthetic target-output unit receives exactly the declared
    // 5/s, apportioned 1/s from r_cheap and 4/s from r_dear.
    const unitRecipe = new Map(
      plan.units
        .filter((u) => u.kind === "recipe")
        .map((u) => [u.id, (u as { recipeId: string }).recipeId]),
    );
    const targetEdges = plan.edges.filter(
      (e) => e.toUnit === "u:out:gold" && e.item === "gold",
    );
    const total = targetEdges.reduce((acc, e) => acc.add(e.rate), zero);
    expect(total.equals(5)).toBe(true);
    const byProducer = new Map<string, Fraction>();
    for (const e of targetEdges) {
      const rid = unitRecipe.get(e.fromUnit) ?? e.fromUnit;
      byProducer.set(rid, (byProducer.get(rid) ?? zero).add(e.rate));
    }
    expect(byProducer.get("r_cheap")?.equals(1)).toBe(true);
    expect(byProducer.get("r_dear")?.equals(4)).toBe(true);
  });
});

describe("co-product target items through replicate and render", () => {
  // Scenario 17: "co" is r_co's SECOND output; the declared draw must be keyed
  // to the co-product item so r_use's main demand still sees r_co's full main
  // production as its split weight.
  it("feeds the primary-output consumer despite a co-product draw on its producer", () => {
    const { pack: p, targets } = coProductTarget;
    const full = solvePlanWithIntermediates(targets, p, defaultTransportConfig);

    const zero = new Fraction(0);
    const sumOf = (rid: string) =>
      full.replicas
        .filter((r) => r.recipeId === rid)
        .reduce((acc, r) => acc.add(r.executionRate), zero);
    expect(full.rates.get("r_co")!.equals(1)).toBe(true);
    expect(full.rates.get("r_use")!.equals(1)).toBe(true);
    expect(sumOf("r_co").equals(1)).toBe(true);
    expect(sumOf("r_use").equals(1)).toBe(true);

    const { plan } = renderPlanFromSolve(full, p, targets, []);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack: p,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);

    // Both target output units are fed at exactly their declared rates.
    const inflowOf = (item: string) =>
      plan.edges
        .filter((e) => e.toUnit === `u:out:${item}` && e.item === item)
        .reduce((acc, e) => acc.add(e.rate), zero);
    expect(inflowOf("co").equals(1)).toBe(true);
    expect(inflowOf("cout").equals(1)).toBe(true);
    // The consumer is fed its full main demand.
    const useUnit = plan.units.find(
      (u) => u.kind === "recipe" && u.recipeId === "r_use",
    )!;
    const mainInflow = plan.edges
      .filter((e) => e.toUnit === useUnit.id && e.item === "main")
      .reduce((acc, e) => acc.add(e.rate), zero);
    expect(mainInflow.equals(1)).toBe(true);
  });

  // Scenario 18: one recipe produces TWO target items; the seed must emit
  // once and the per-item draws must both be honored.
  it("seeds a two-target-item recipe once and feeds both target outputs", () => {
    const { pack: p, targets } = dualTargetItemsOneRecipe;
    const full = solvePlanWithIntermediates(targets, p, defaultTransportConfig);

    expect(full.rates.get("r_dual")!.equals(1)).toBe(true);
    const dualReplicas = full.replicas.filter((r) => r.recipeId === "r_dual");
    expect(dualReplicas).toHaveLength(1);
    expect(dualReplicas[0]!.executionRate.equals(1)).toBe(true);

    const { plan } = renderPlanFromSolve(full, p, targets, []);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack: p,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);

    const zero = new Fraction(0);
    const inflowOf = (unitId: string, item: string) =>
      plan.edges
        .filter((e) => e.toUnit === unitId && e.item === item)
        .reduce((acc, e) => acc.add(e.rate), zero);
    expect(inflowOf("u:out:a", "a").equals(1)).toBe(true);
    expect(inflowOf("u:out:b", "b").equals(1)).toBe(true);
    // The extra unit of b is free-disposal surplus.
    const surplusUnit = plan.units.find(
      (u) => u.kind === "outputProduct" && u.itemId === "b" && u.flavor === "surplus",
    );
    expect(surplusUnit).toBeDefined();
    expect(inflowOf(surplusUnit!.id, "b").equals(1)).toBe(true);
  });

  // Shipped pack: liquid_sewage is a co-product-only item (never a primary
  // output of a non-excluded recipe). Targeting it must solve and render with
  // every checker green.
  it("shipped pack: liquid_sewage as a target renders clean", () => {
    const targets: ItemTarget[] = [
      { itemId: "liquid_sewage", ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
    );
    expect(full.feasibility.softFeasible).toBe(true);
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);
    const zero = new Fraction(0);
    const inflow = plan.edges
      .filter((e) => e.toUnit === "u:out:liquid_sewage" && e.item === "liquid_sewage")
      .reduce((acc, e) => acc.add(e.rate), zero);
    expect(inflow.equals(1)).toBe(true);
  });
});

describe("free-boundary target items through render", () => {
  // iron_ore is raw:true on the shipped pack: the LP builds no row, nothing
  // runs (status "empty"), and the declared rate is met by a reported
  // boundary draw. The render must feed the target output unit from a
  // boundary import (import -> export passthrough) with every checker green.
  it("shipped pack: iron_ore at 1/s renders as an import -> export passthrough", () => {
    const targets: ItemTarget[] = [
      { itemId: "iron_ore", ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
    );
    expect(full.feasibility.softFeasible).toBe(true);
    expect(full.rates.size).toBe(0);

    const { plan } = renderPlanFromSolve(full, pack, targets, []);
    const violations = checkRenderPlan({
      plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides: [],
    }).flatMap((r) => r.violations);
    expect(violations).toEqual([]);

    const zero = new Fraction(0);
    // The target output unit exists and receives exactly the declared rate.
    const outUnit = plan.units.find(
      (u) => u.kind === "outputProduct" && u.itemId === "iron_ore",
    );
    expect(outUnit).toBeDefined();
    const inflow = plan.edges
      .filter((e) => e.toUnit === "u:out:iron_ore" && e.item === "iron_ore")
      .reduce((acc, e) => acc.add(e.rate), zero);
    expect(inflow.equals(1)).toBe(true);
    // The feed comes from a boundary input product of the same item.
    const inUnitIds = new Set(
      plan.units
        .filter((u) => u.kind === "inputProduct" && u.itemId === "iron_ore")
        .map((u) => u.id),
    );
    expect(inUnitIds.size).toBeGreaterThan(0);
    for (const e of plan.edges) {
      if (e.toUnit !== "u:out:iron_ore") continue;
      expect(inUnitIds.has(e.fromUnit)).toBe(true);
    }
  });
});
