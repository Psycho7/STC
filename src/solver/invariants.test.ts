import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import {
  checkMassBalance,
  checkTargetsMet,
  checkRawOnlyBoundary,
  checkRepresentable,
  checkNoOrphanLogicalNodes,
} from "./invariants";
import { solveLp, type LpResult } from "./lp";
import { solvePlanWithIntermediates, type SolvePlanFull } from "./index";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";

const headlineTargets: Target[] = [
  { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
];
const noOverrides: ItemOverride[] = [];

function makeFull(): SolvePlanFull {
  return solvePlanWithIntermediates(
    headlineTargets,
    pack,
    defaultTransportConfig,
  );
}

describe("invariants - headline plan (all checkers pass)", () => {
  it("checkMassBalance returns ok:true", () => {
    const r = checkMassBalance(
      solveLp({ targets: headlineTargets, pack }),
      pack,
      headlineTargets,
      noOverrides,
    );
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("checkTargetsMet returns ok:true", () => {
    const r = checkTargetsMet(
      solveLp({ targets: headlineTargets, pack }),
      headlineTargets,
      pack,
    );
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("checkRawOnlyBoundary returns ok:true", () => {
    const r = checkRawOnlyBoundary(
      solveLp({ targets: headlineTargets, pack }),
      pack,
      noOverrides,
    );
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("checkRepresentable returns ok:true", () => {
    const r = checkRepresentable(makeFull());
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("checkNoOrphanLogicalNodes - headline plan", () => {
  // The headline plan has no orphan logical nodes. The earlier copper_enr
  // orphan was a zero-rate producer the SCC boundary walk materialized as a
  // phantom replica; splitting boundary demand by LP rate and skipping
  // zero-share producers removed it.
  it("reports no orphans on the headline plan", () => {
    const r = checkNoOrphanLogicalNodes(makeFull());
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("checkMassBalance - detection power", () => {
  // Corrupt a recipe's rate (not surplus) so production/consumption no longer
  // balances. Mutating surplus would also trip checkRawOnlyBoundary; mutating
  // a rate isolates the residual to this checker.
  it("flags an injected rate imbalance on a recipe", () => {
    const good = solveLp({ targets: headlineTargets, pack });
    const target = "xiranite_enr_powder";
    const cur = good.rates.get(target)!;
    const corrupted: LpResult = {
      ...good,
      rates: new Map(good.rates).set(target, cur.mul(new Fraction(2))),
    };
    const r = checkMassBalance(corrupted, pack, headlineTargets, noOverrides);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  // A non-raw item with a plan:true override is an uncapped boundary: the LP
  // skips its mass-balance row (effectiveSupply === Infinity), so the checker
  // must skip it too. The old it.raw skip built a row the LP never had and
  // reported a false-positive residual.
  it("does NOT flag a non-raw plan:true boundary item the LP left uncapped", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          cost: 1,
          in: [{ item: "prod", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    // Mark `prod` as an uncapped boundary; the LP draws it freely with no
    // mass-balance row, so net consumption without a deficit is fine.
    const overrides: ItemOverride[] = [{ itemId: "prod", plan: true }];
    const targets: Target[] = [
      { recipeId: "sink", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p, itemOverrides: overrides });
    const r = checkMassBalance(result, p, targets, overrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("checkTargetsMet - detection power", () => {
  it("flags a target running below its floor rate", () => {
    const good = solveLp({ targets: headlineTargets, pack });
    const cur = good.rates.get("xiranite_enr_powder")!;
    const corrupted: LpResult = {
      ...good,
      rates: new Map(good.rates).set(
        "xiranite_enr_powder",
        cur.div(new Fraction(2)),
      ),
    };
    const r = checkTargetsMet(corrupted, headlineTargets, pack);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("xiranite_enr_powder"))).toBe(
      true,
    );
  });

  it("flags a target absent from rates entirely", () => {
    const good = solveLp({ targets: headlineTargets, pack });
    const stripped = new Map(good.rates);
    stripped.delete("xiranite_enr_powder");
    const corrupted: LpResult = { ...good, rates: stripped };
    const r = checkTargetsMet(corrupted, headlineTargets, pack);
    expect(r.ok).toBe(false);
  });
});

describe("checkRawOnlyBoundary - detection power", () => {
  it("flags surplus exceeding net production on a non-raw, non-overridden item", () => {
    const good = solveLp({ targets: headlineTargets, pack });
    // xiranite_enr_powder is non-raw and fully consumed as the target's primary
    // output (no spare production), so a large injected surplus is not backed by
    // net production and must be flagged.
    const bogusItem = "xiranite_enr_powder";
    const corrupted: LpResult = {
      ...good,
      surplus: new Map(good.surplus).set(bogusItem, new Fraction(5)),
    };
    const r = checkRawOnlyBoundary(corrupted, pack, noOverrides);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes(bogusItem))).toBe(true);
  });

  it("flags net consumption over production without a deficit on a non-raw item", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          in: [{ item: "prod", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    const corrupted: LpResult = {
      rates: new Map([["sink", new Fraction(1)]]),
      surplus: new Map(),
      deficit: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, noOverrides);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("prod"))).toBe(true);
  });

  // A non-raw item with a finite ratePerSec override is a capped boundary:
  // effectiveSupply returns the cap as a Fraction. Drawing external supply at or
  // below the cap must NOT be flagged. The old net-based logic treated any
  // capped item like a 0-supply item -> false positive.
  it("does NOT flag a capped-override item consumed within its cap", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          in: [{ item: "prod", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    // Cap external supply of `prod` at 5/sec; sink draws exactly 1/sec.
    const overrides: ItemOverride[] = [
      { itemId: "prod", ratePerSec: { num: "5", denom: "1" } },
    ];
    const corrupted: LpResult = {
      rates: new Map([["sink", new Fraction(1)]]),
      surplus: new Map(),
      deficit: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, overrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // Tolerance scales with cap magnitude. A 1e6 cap drawn at 1e6 + 0.5 is over by
  // 0.5, above a flat 1e-6 absolute slack but within the scaled slack
  // (1e6 * 1e-6 = 1.0). It must NOT be flagged; the old flat REL_TOL would have
  // produced a false positive.
  it("does NOT flag a large-cap item over by less than the scaled slack", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          in: [{ item: "prod", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    const overrides: ItemOverride[] = [
      { itemId: "prod", ratePerSec: { num: "1000000", denom: "1" } },
    ];
    const corrupted: LpResult = {
      // sink draws prod at 1000000.5/sec -> external supply 0.5 over the cap.
      rates: new Map([["sink", new Fraction(2000001, 2)]]),
      surplus: new Map(),
      deficit: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, overrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("flags a capped-override item consumed beyond its cap", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          in: [{ item: "prod", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    // Cap external supply of `prod` at 5/sec; sink draws 10/sec -> over cap.
    const overrides: ItemOverride[] = [
      { itemId: "prod", ratePerSec: { num: "5", denom: "1" } },
    ];
    const corrupted: LpResult = {
      rates: new Map([["sink", new Fraction(10)]]),
      surplus: new Map(),
      deficit: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, overrides);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("prod"))).toBe(true);
  });
});

describe("checkRepresentable - detection power", () => {
  it("flags a positive-rate recipe missing from the logical graph", () => {
    const full = makeFull();
    const fakeId = "__bogus_unrepresented_recipe";
    const fakeRecipe = {
      id: fakeId,
      category: "material",
      time: 1,
      cost: 1,
      in: [],
      out: [{ item: "x", qty: 1 }],
    } as unknown as Recipe;
    const corrupted: SolvePlanFull = {
      ...full,
      rates: new Map(full.rates).set(fakeId, new Fraction(3)),
      recipeById: new Map(full.recipeById).set(fakeId, fakeRecipe),
    };
    const r = checkRepresentable(corrupted);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes(fakeId))).toBe(true);
  });

  it("does NOT flag a positive-rate __domain_transfer recipe absent from the graph", () => {
    const full = makeFull();
    const xferId = "__sanctioned_transfer";
    const xferRecipe = {
      id: xferId,
      category: "__domain_transfer",
      time: 1,
      cost: 1,
      in: [],
      out: [{ item: "x", qty: 1 }],
    } as unknown as Recipe;
    const corrupted: SolvePlanFull = {
      ...full,
      rates: new Map(full.rates).set(xferId, new Fraction(3)),
      recipeById: new Map(full.recipeById).set(xferId, xferRecipe),
    };
    const r = checkRepresentable(corrupted);
    expect(r.violations.some((v) => v.includes(xferId))).toBe(false);
  });
});

describe("checkNoOrphanLogicalNodes - detection power", () => {
  it("flags a logical recipe node that has no positive LP rate", () => {
    const full = makeFull();
    // Drop every rate so each logical recipe node becomes an orphan; the
    // checker must report at least one violation.
    const stripped: SolvePlanFull = { ...full, rates: new Map() };
    const r = checkNoOrphanLogicalNodes(stripped);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
