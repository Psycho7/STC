import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";
import {
  checkMassBalance,
  checkTargetsMet,
  checkRawOnlyBoundary,
  checkCatalystAccount,
  checkRepresentable,
  checkNoOrphanLogicalNodes,
  assertInvariants,
  checkSolvePlan,
  SOLVER_INVARIANT_CHECKERS,
  type SolverInvariantArgs,
} from "./invariants";
import { solveLp, type LpResult } from "./lp";
import { solvePlanWithIntermediates, type SolvePlanFull } from "./index";
import { withoutGasMachines } from "./closed-form-fixtures";
import { netSelfConsumption, type NettedRecipeMap } from "./net-self";
import { pack } from "../data/load";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipePack } from "@aef/schema";

// game v1.4's gas-system machines let the LP route xiranite_enr_powder through
// a gas chain, so the recipe keyed "xiranite_enr_powder" no longer runs on the
// full pack. The detection-power tests corrupt that recipe's rate; solving them
// against a pack without the gas-machine recipes keeps the original headline
// plan (every upstream recipe is unchanged) so the corruption has a rate to hit.
const legacyPack: RecipePack = withoutGasMachines(pack);

const headlineTargets: ItemTarget[] = [
  {
    itemId: "xiranite_enr_powder",
    ratePerSec: { num: "6", denom: "60" },
  },
];
const noOverrides: ItemOverride[] = [];

function makeFull(): SolvePlanFull {
  return solvePlanWithIntermediates(headlineTargets, pack);
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
    // legacyPack: the corrupted recipe key only runs on the pre-gas route.
    const good = solveLp({ targets: headlineTargets, pack: legacyPack });
    const target = "xiranite_enr_powder";
    const cur = good.rates.get(target)!;
    const corrupted: LpResult = {
      ...good,
      rates: new Map(good.rates).set(target, cur.mul(new Fraction(2))),
    };
    const r = checkMassBalance(
      corrupted,
      legacyPack,
      headlineTargets,
      noOverrides,
    );
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
    const targets: ItemTarget[] = [
      { itemId: "final", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p, itemOverrides: overrides });
    const r = checkMassBalance(result, p, targets, overrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe("checkMassBalance - bounded supply draw", () => {
  // copper_powder @1/60 with copper_nugget capped at 10/s: the LP covers the
  // nugget consumption with a bounded boundary draw. The checker must mirror
  // the draw term of the mass-balance row; the old supply-blind residual was
  // exactly -cap on every correct finite-cap solve.
  const capTargets: ItemTarget[] = [
    {
      itemId: "copper_powder",
      ratePerSec: { num: "1", denom: "60" },
    },
  ];
  const capOverrides: ItemOverride[] = [
    { itemId: "copper_nugget", ratePerSec: { num: "10", denom: "1" } },
  ];

  it("passes on a finite-cap solve and reports the consumed draw", () => {
    const result = solveLp({
      targets: capTargets,
      pack,
      itemOverrides: capOverrides,
    });
    const r = checkMassBalance(result, pack, capTargets, capOverrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
    // The free draw covers exactly what production does not: the whole nugget
    // consumption of 1/60 exec/s * 1 nugget.
    const draw = result.draws.get("copper_nugget");
    expect(draw).toBeDefined();
    expect(draw!.equals(new Fraction(1, 60))).toBe(true);
  });

  it("flags a corrupted draws entry that breaks the row", () => {
    const good = solveLp({
      targets: capTargets,
      pack,
      itemOverrides: capOverrides,
    });
    const corrupted: LpResult = {
      ...good,
      draws: new Map(good.draws).set("copper_nugget", new Fraction(5)),
    };
    const r = checkMassBalance(corrupted, pack, capTargets, capOverrides);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("copper_nugget"))).toBe(true);
  });

  it("solvePlanWithIntermediates does not throw on a finite cap under DEV invariants", () => {
    const full = solvePlanWithIntermediates(capTargets, pack, capOverrides);
    expect(full.logical.nodes.length).toBeGreaterThan(0);
  });
});

describe("checkTargetsMet - detection power", () => {
  // The demand-side rate corruptions the old floor check caught (a halved or
  // stripped producer rate) now surface through checkMassBalance: the demand
  // equality no longer closes. checkTargetsMet's remaining job is the
  // self-report seam: a result claiming softFeasible while a target item
  // carries a material deficit is lying about the demand being met.
  it("flags a claimed-feasible result with a deficit on a target item", () => {
    const good = solveLp({ targets: headlineTargets, pack });
    expect(good.softFeasible).toBe(true);
    const corrupted: LpResult = {
      ...good,
      deficit: new Map(good.deficit).set(
        "xiranite_enr_powder",
        new Fraction(1, 100),
      ),
    };
    const r = checkTargetsMet(corrupted, headlineTargets);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("xiranite_enr_powder"))).toBe(
      true,
    );
  });

  it("skips an honest soft-infeasible result", () => {
    const good = solveLp({ targets: headlineTargets, pack });
    const corrupted: LpResult = {
      ...good,
      softFeasible: false,
      deficit: new Map(good.deficit).set(
        "xiranite_enr_powder",
        new Fraction(1, 100),
      ),
    };
    const r = checkTargetsMet(corrupted, headlineTargets);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("halving a target producer's rate is caught by checkMassBalance", () => {
    // legacyPack: the halved recipe key only runs on the pre-gas route.
    const good = solveLp({ targets: headlineTargets, pack: legacyPack });
    const cur = good.rates.get("xiranite_enr_powder")!;
    const corrupted: LpResult = {
      ...good,
      rates: new Map(good.rates).set(
        "xiranite_enr_powder",
        cur.div(new Fraction(2)),
      ),
    };
    const r = checkMassBalance(
      corrupted,
      legacyPack,
      headlineTargets,
      noOverrides,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("xiranite_enr_powder"))).toBe(
      true,
    );
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
      draws: new Map(),
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
      draws: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, overrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // A catalyst is cycled rather than consumed, so it never shows up in
  // production or consumption - and since the LP charges it against no cap,
  // this checker must not either. Consumption alone fits under the cap here;
  // consumption plus the cycled draw would not, and that is not a violation.
  it("does NOT flag a capped item whose catalyst use would exceed the cap", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          in: [{ item: "prod", qty: 1 }],
          catalyst: [{ item: "prod", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    // Cap prod at 3/sec. sink runs at 2/sec: 2 consumed plus 2 cycled = 4.
    const overrides: ItemOverride[] = [
      { itemId: "prod", ratePerSec: { num: "3", denom: "1" } },
    ];
    const corrupted: LpResult = {
      rates: new Map([["sink", new Fraction(2)]]),
      surplus: new Map(),
      deficit: new Map(),
      draws: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, overrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  // The same rule on the other side of the cap: a plain non-raw item has
  // effectiveSupply 0, and a catalyst cycled on it is still not a boundary
  // draw this checker knows about - liquid_xiranite on the real pack is
  // exactly that item.
  it("does NOT flag a catalyst cycled on a zero-supply item", () => {
    const p = {
      recipes: [
        {
          id: "sink",
          category: "material",
          time: 1,
          in: [],
          catalyst: [{ item: "cycled", qty: 1 }],
          out: [{ item: "final", qty: 1 }],
        },
      ],
      items: [
        { id: "cycled", raw: false },
        { id: "final", raw: false },
      ],
    } as unknown as typeof pack;
    const corrupted: LpResult = {
      rates: new Map([["sink", new Fraction(2)]]),
      surplus: new Map(),
      deficit: new Map(),
      draws: new Map(),
      objectiveValue: 0,
      solverWallClockMs: 0,
      status: "feasible",
      softFeasible: true,
    };
    const r = checkRawOnlyBoundary(corrupted, p, noOverrides);
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
      draws: new Map(),
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
      draws: new Map(),
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

// The account has no LP row behind it, so this checker is the only thing that
// would notice it drifting from the machine counts and pools it is derived
// from. Driven on a transmuter plan, the one shape that cycles anything.
describe("checkCatalystAccount", () => {
  const catalystTargets: ItemTarget[] = [
    { itemId: "gas_copper", ratePerSec: { num: "1", denom: "1" } },
  ];
  const nettedPack = netSelfConsumption(pack);

  function solveCatalystPlan(): {
    full: SolvePlanFull;
    result: LpResult;
  } {
    return {
      full: solvePlanWithIntermediates(catalystTargets, pack, noOverrides),
      result: solveLp({ targets: catalystTargets, pack: nettedPack }),
    };
  }

  it("returns ok:true on a solved transmuter plan", () => {
    const { full, result } = solveCatalystPlan();
    expect(full.catalystAccount.size).toBeGreaterThan(0);
    const r = checkCatalystAccount(full, result, nettedPack, noOverrides);
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("returns ok:true on the catalyst-free headline plan", () => {
    const r = checkCatalystAccount(
      makeFull(),
      solveLp({ targets: headlineTargets, pack: nettedPack }),
      nettedPack,
      noOverrides,
    );
    expect(r.ok, r.violations.join("\n")).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("flags an account whose need was tampered with", () => {
    const { full, result } = solveCatalystPlan();
    const reported = full.catalystAccount.get("gas_xiranite")!;
    const corrupted: SolvePlanFull = {
      ...full,
      catalystAccount: new Map([
        [
          "gas_xiranite",
          { ...reported, need: reported.need.add(new Fraction(1, 3)) },
        ],
      ]),
    };
    const r = checkCatalystAccount(corrupted, result, nettedPack, noOverrides);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("need"))).toBe(true);
  });

  it("flags an account that bills the need to the wrong pool", () => {
    const { full, result } = solveCatalystPlan();
    const reported = full.catalystAccount.get("gas_xiranite")!;
    const corrupted: SolvePlanFull = {
      ...full,
      catalystAccount: new Map([
        [
          "gas_xiranite",
          {
            ...reported,
            fromCatalyst: reported.need,
            fromGeneral: new Fraction(0),
          },
        ],
      ]),
    };
    const r = checkCatalystAccount(corrupted, result, nettedPack, noOverrides);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes("fromCatalyst"))).toBe(true);
    expect(r.violations.some((v) => v.includes("fromGeneral"))).toBe(true);
  });

  it("flags an omitted entry and an invented one", () => {
    const { full, result } = solveCatalystPlan();
    const omitted: SolvePlanFull = { ...full, catalystAccount: new Map() };
    expect(
      checkCatalystAccount(omitted, result, nettedPack, noOverrides).violations,
    ).toEqual([expect.stringContaining("omits gas_xiranite")]);

    const zero = new Fraction(0);
    const invented: SolvePlanFull = {
      ...full,
      catalystAccount: new Map([
        ...full.catalystAccount,
        [
          "copper_ore",
          {
            need: new Fraction(1),
            fromCatalyst: zero,
            fromGeneral: new Fraction(1),
            unmet: zero,
          },
        ],
      ]),
    };
    expect(
      checkCatalystAccount(invented, result, nettedPack, noOverrides)
        .violations,
    ).toEqual([expect.stringContaining("reports copper_ore")]);
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
      nettedRecipeById: new Map(full.nettedRecipeById).set(
        fakeId,
        fakeRecipe,
      ) as NettedRecipeMap,
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
      nettedRecipeById: new Map(full.nettedRecipeById).set(
        xferId,
        xferRecipe,
      ) as NettedRecipeMap,
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

// A recipe-cost map that records whether anything read it. Only the `optimal`
// row consumes recipe costs, so a read is proof that row ran.
class TracingCosts extends Map<string, number> {
  read = false;

  override get(key: string): number | undefined {
    this.read = true;
    return super.get(key);
  }

  override [Symbol.iterator](): MapIterator<[string, number]> {
    this.read = true;
    return super[Symbol.iterator]();
  }
}

describe("solver invariant table", () => {
  const nettedPack = netSelfConsumption(pack);

  function makeArgs(recipeCosts: Map<string, number>): SolverInvariantArgs {
    return {
      full: makeFull(),
      result: solveLp({ targets: headlineTargets, pack: nettedPack }),
      pack: nettedPack,
      targets: headlineTargets,
      itemOverrides: noOverrides,
      recipeCosts,
    };
  }

  it("registers the seven rows in order, asserting only the first five", () => {
    expect(SOLVER_INVARIANT_CHECKERS.map((c) => c.name)).toEqual([
      "massBalance",
      "targetsMet",
      "rawOnlyBoundary",
      "catalystAccount",
      "representable",
      "noOrphanLogicalNodes",
      "optimal",
    ]);
    expect(SOLVER_INVARIANT_CHECKERS.map((c) => c.asserted)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("returns one result per row, index-aligned with the table", () => {
    const results = checkSolvePlan(makeArgs(new Map()));
    expect(results.length).toBe(SOLVER_INVARIANT_CHECKERS.length);
    for (const [i, row] of SOLVER_INVARIANT_CHECKERS.entries()) {
      expect(results[i], row.name).toEqual(row.check(makeArgs(new Map())));
    }
  });

  it("skips the optimal row on the assert path but runs it when reporting", () => {
    const assertCosts = new TracingCosts();
    assertInvariants(makeArgs(assertCosts));
    expect(assertCosts.read).toBe(false);

    const reportCosts = new TracingCosts();
    checkSolvePlan(makeArgs(reportCosts));
    expect(reportCosts.read).toBe(true);
  });

  it("forwards the unavailable set to the optimal row", () => {
    // mid_cheap is cheaper at intrinsic costs but switched off, and the cost
    // override keeps the base on the pricey chain either way. Only a re-solve
    // that still sees mid_cheap can report a violation.
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
    } as unknown as typeof pack;
    const targets: ItemTarget[] = [
      { itemId: "prod", ratePerSec: { num: "1", denom: "1" } },
    ];
    const optimal = SOLVER_INVARIANT_CHECKERS.find(
      (c) => c.name === "optimal",
    )!;
    const res = optimal.check({
      full: makeFull(),
      result: solveLp({ targets, pack: p }),
      pack: p,
      targets,
      itemOverrides: noOverrides,
      recipeCosts: new Map([["mid_cheap", 100]]),
      unavailableRecipeIds: new Set(["mid_cheap"]),
    });
    expect(res.violations).toEqual([]);
  });
});
