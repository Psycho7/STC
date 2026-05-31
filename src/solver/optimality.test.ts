import { describe, expect, it } from "vitest";
import { solveLp } from "./lp";
import {
  recomputeObjective,
  activeRecipeSet,
  assertOptimal,
} from "./optimality";
import { pack } from "../data/load";
import type { Target } from "../data/targets";
import type { RecipePack } from "@aef/schema";

const headline: Target[] = [
  { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
];

describe("recomputeObjective", () => {
  it("matches the emitted objectiveValue on the headline plan", () => {
    const result = solveLp({ targets: headline, pack });
    const recomputed = recomputeObjective(result, pack);
    // Self-consistency: the objective recomputed from the emitted
    // rates/surplus/deficit must agree with what solveLp reported. A relative
    // tolerance keeps float noise (and the 1e-3 surplus weight) from tripping
    // the check.
    const scale = Math.max(1, Math.abs(result.objectiveValue));
    expect(Math.abs(recomputed - result.objectiveValue) / scale).toBeLessThan(
      1e-6,
    );
  });
});

describe("activeRecipeSet", () => {
  it("returns the producer chain on a small acyclic plan", () => {
    // copper_powder consumes `copper_nugget`, which the recipe `copper_nugget`
    // builds from raw copper_ore + liquid_water. So the minimal plan is a
    // two-recipe single-producer chain {copper_powder, copper_nugget}; assert
    // exactly that active set.
    const targets: Target[] = [
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "60" } },
    ];
    const result = solveLp({ targets, pack });
    const active = activeRecipeSet(result);
    expect(active.has("copper_powder")).toBe(true);
    expect(active.has("copper_nugget")).toBe(true);
    expect(active.size).toBe(2);
  });

  it("includes the main and purifier recipes on the headline plan", () => {
    const result = solveLp({ targets: headline, pack });
    const active = activeRecipeSet(result);
    // Tie-aware: assert membership of the known-active recipes plus a sane
    // cardinality, not a fully pinned id list.
    expect(active.has("liquid_xiranite_poly")).toBe(true);
    expect(active.has("liquid_xiranite_poly-purifier")).toBe(true);
    expect(active.size).toBeGreaterThanOrEqual(3);
  });
});

describe("assertOptimal", () => {
  it("returns ok on the headline plan", () => {
    const res = assertOptimal({ targets: headline, pack });
    expect(res.violations).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("abstains (ok:true, no violations) when the base solve is not softFeasible", () => {
    // Pack: recipe T consumes `need` (not raw, no producer) and produces `prod`.
    // The LP cannot supply `need`, so a deficit var survives -> softFeasible===false.
    // assertOptimal should return ok:true with no violations (screen abstains).
    const p = {
      recipes: [
        {
          id: "T",
          category: "material",
          time: 1,
          in: [{ item: "need", qty: 1 }],
          out: [{ item: "prod", qty: 1 }],
        },
      ],
      items: [
        { id: "need", raw: false },
        { id: "prod", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: Target[] = [
      { recipeId: "T", ratePerSec: { num: "1", denom: "1" } },
    ];

    // Sanity: confirm the base is genuinely not softFeasible.
    expect(solveLp({ targets, pack: p }).softFeasible).toBe(false);

    const res = assertOptimal({ targets, pack: p });
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it("detects a planted-suboptimal recipe-cost misconfiguration", () => {
    // Two chains produce `mid` for the target T:
    //   - mid_cheap:  raw_a -> mid                              (1 recipe run)
    //   - mid_pricey: inter -> mid, plus make_inter: raw_a -> inter (2 runs)
    // At intrinsic (default unit) costs the cheap chain wins: the plan
    // {T, mid_cheap} is 2 recipe-runs versus {T, mid_pricey, make_inter} at 3.
    // A recipeCosts override pins mid_cheap at cost 100, which steers solveLp
    // onto the pricey 3-run chain. The witness scores at intrinsic costs, so it
    // sees that forcing mid_cheap active again yields the strictly cheaper
    // 2-run plan -> the override-driven base is suboptimal -> a violation.
    // This is a genuine counterexample: if assertOptimal were a vacuous
    // ok:true stub, this assertion would fail.
    const p = {
      recipes: [
        {
          id: "T",
          category: "material",
          time: 1,
          in: [{ item: "mid", qty: 1 }],
          out: [{ item: "prod", qty: 1 }],
        },
        {
          id: "mid_cheap",
          category: "material",
          time: 1,
          in: [{ item: "raw_a", qty: 1 }],
          out: [{ item: "mid", qty: 1 }],
        },
        {
          id: "mid_pricey",
          category: "material",
          time: 1,
          in: [{ item: "inter", qty: 1 }],
          out: [{ item: "mid", qty: 1 }],
        },
        {
          id: "make_inter",
          category: "material",
          time: 1,
          in: [{ item: "raw_a", qty: 1 }],
          out: [{ item: "inter", qty: 1 }],
        },
      ],
      items: [
        { id: "raw_a", raw: true },
        { id: "inter", raw: false },
        { id: "mid", raw: false },
        { id: "prod", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: Target[] = [
      { recipeId: "T", ratePerSec: { num: "1", denom: "1" } },
    ];
    const recipeCosts = new Map<string, number>([["mid_cheap", 100]]);

    // Sanity: the base solve under the override really does pick the pricey
    // 3-run chain (so the scenario is the intended counterexample, not a
    // degenerate tie or an honest optimum).
    const base = solveLp({ targets, pack: p, recipeCosts });
    expect(base.rates.has("mid_pricey")).toBe(true);
    expect(base.rates.has("mid_cheap")).toBe(false);

    const res = assertOptimal({ targets, pack: p, recipeCosts });
    expect(res.ok).toBe(false);
    expect(res.violations.length).toBeGreaterThan(0);
  });
});
