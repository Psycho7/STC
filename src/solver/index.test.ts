import { describe, expect, it, vi } from "vitest";
import Fraction from "fraction.js";
import { LpInfeasibleError, solvePlan, solvePlanWithIntermediates } from "./index";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { ItemTarget } from "../data/targets";
import type { RecipePack } from "@aef/schema";
import type { LpResult } from "./lp";

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
    const full = solvePlanWithIntermediates(
      targets,
      pack,
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

  it("does not throw on an empty-but-feasible optimum (solvePlan)", () => {
    const logical = solvePlan(
      emptyFeasibleTargets,
      emptyFeasiblePack,
      defaultTransportConfig,
    );
    expect(logical.nodes.length).toBe(0);
  });

  // (a) Infeasible: status "infeasible" is unreachable through the public API
  // with real packs (universal slack, see the override note above), so the flag
  // forces solveLp's status. Both entry points must surface it as a throw whose
  // message matches /infeasible/.
  const targets: ItemTarget[] = [
    {
      itemId: "xiranite_enr_powder",
      ratePerSec: { num: "6", denom: "60" },
    },
  ];

  it("throws on infeasible status (both entry points)", () => {
    lpStatusOverride.status = "infeasible";
    try {
      expect(() =>
        solvePlanWithIntermediates(targets, pack, defaultTransportConfig),
      ).toThrow(/infeasible/);
      expect(() =>
        solvePlan(targets, pack, defaultTransportConfig),
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
