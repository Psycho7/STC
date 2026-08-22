import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp, type LpResult } from "./lp";
import { makePack } from "./closed-form-fixtures";
import { effectiveSupply } from "./effectiveSupply";
import { pack } from "../data/load";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipePack } from "@aef/schema";

// game v1.4 added the gas-system machines whose recipes let the LP route
// xiranite_enr_powder through a gas chain, displacing the water-fed
// main+purifier producers this file's headline regression pins. Solving
// against a pack without the gas-machine recipes reproduces the exact
// pre-v1.4 plan (every upstream recipe is unchanged).
const GAS_MACHINES = new Set([
  "gas_pump_1",
  "gas_reactor_1",
  "phase_trans_1",
  "phase_trans_2",
]);
const legacyPack: RecipePack = {
  ...pack,
  recipes: pack.recipes.filter(
    (r) => !r.producers.some((p) => GAS_MACHINES.has(p)),
  ),
};

// Exact per-item mass-balance residual over the extracted result:
// production - consumption + draw - surplus + deficit - demand, in Fraction
// arithmetic, for every finite-supply item. The extraction recomputes
// surplus/deficit from the final rates, so a hygienic result closes every row
// to exactly zero.
function exactResiduals(
  result: LpResult,
  p: RecipePack,
  targets: ItemTarget[],
  overrides: ItemOverride[] = [],
): Map<string, Fraction> {
  const zero = new Fraction(0);
  const demand = new Map<string, Fraction>();
  for (const t of targets) {
    const rate = new Fraction(`${t.ratePerSec.num}/${t.ratePerSec.denom}`);
    demand.set(t.itemId, (demand.get(t.itemId) ?? zero).add(rate));
  }
  const residuals = new Map<string, Fraction>();
  for (const it of p.items) {
    const supply = effectiveSupply(it.id, p, overrides);
    if (supply === Infinity) continue;
    let bal = zero;
    for (const r of p.recipes) {
      const rate = result.rates.get(r.id);
      if (!rate) continue;
      const out = r.out.find((o) => o.item === it.id)?.qty ?? 0;
      const inq = r.in.find((i) => i.item === it.id)?.qty ?? 0;
      if (out !== inq) bal = bal.add(rate.mul(out - inq));
    }
    const surplus = result.surplus.get(it.id) ?? zero;
    const deficit = result.deficit.get(it.id) ?? zero;
    residuals.set(
      it.id,
      bal
        .add(result.draws.get(it.id) ?? zero)
        .sub(surplus)
        .add(deficit)
        .sub(demand.get(it.id) ?? zero),
    );
  }
  return residuals;
}

function expectExactlyBalanced(
  result: LpResult,
  p: RecipePack,
  targets: ItemTarget[],
  overrides: ItemOverride[] = [],
): void {
  for (const [itemId, residual] of exactResiduals(
    result,
    p,
    targets,
    overrides,
  )) {
    expect(
      residual.equals(0),
      `exact residual for ${itemId}: ${residual.toFraction()}`,
    ).toBe(true);
  }
}

describe("solveLp - scaffold", () => {
  it("returns an empty LpResult on no targets", () => {
    const result = solveLp({ targets: [], pack });
    expect(result.rates).toBeInstanceOf(Map);
    expect(result.surplus).toBeInstanceOf(Map);
    expect(result.deficit).toBeInstanceOf(Map);
    expect(result.rates.size).toBe(0);
    expect(typeof result.objectiveValue).toBe("number");
    expect(typeof result.solverWallClockMs).toBe("number");
  });
});

describe("solveLp - single-item target", () => {
  it("meets a single acyclic item demand at the requested rate", () => {
    const targets: ItemTarget[] = [
      { itemId: "copper_powder", ratePerSec: { num: "1", denom: "60" } },
    ];
    const result = solveLp({ targets, pack });
    const x = result.rates.get("copper_powder");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1, 60))).toBe(true);
  });
});

// legacyPack: the 4:1 main+purifier coexistence is the named regression
// witness here. On the full v1.4 pack the LP routes xiranite_enr_powder through
// the gas chain, so neither producer runs; the pre-gas pack keeps the witness.
describe("solveLp - headline (4:1 purifier)", () => {
  const targets: ItemTarget[] = [
    { itemId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
  ];

  it("meets the target demand at 6/min (0.1 enr_powder/sec)", () => {
    const result = solveLp({ targets, pack: legacyPack });
    const xEnr = result.rates.get("xiranite_enr_powder");
    expect(xEnr).toBeDefined();
    expect(xEnr!.equals(new Fraction(1, 10))).toBe(true);
  });

  it("runs the main and purifier recipes at a 4:1 ratio", () => {
    const result = solveLp({ targets, pack: legacyPack });
    const xMain = result.rates.get("liquid_xiranite_poly");
    const xPurifier = result.rates.get("liquid_xiranite_poly-purifier");
    expect(xMain, "main liquid_xiranite_poly must be active").toBeDefined();
    expect(xPurifier, "purifier must be active").toBeDefined();
    expect(xMain!.equals(new Fraction(2, 5))).toBe(true); // 0.4/sec
    expect(xPurifier!.equals(new Fraction(1, 10))).toBe(true); // 0.1/sec
  });

  it("produces zero liquid_xiranite_lowpoly surplus", () => {
    const result = solveLp({ targets, pack: legacyPack });
    const lowpoly = result.surplus.get("liquid_xiranite_lowpoly");
    if (lowpoly !== undefined) expect(lowpoly.equals(0)).toBe(true);
  });
});

describe("solveLp - determinism", () => {
  const targets: ItemTarget[] = [
    { itemId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
  ];

  function ratesSignature(rates: Map<string, Fraction>): string {
    return [...rates.entries()]
      .map(([k, v]) => `${k}=${v.toFraction()}`)
      .sort()
      .join("|");
  }

  function shuffle<T>(arr: T[], seed: number): T[] {
    const a = [...arr];
    let s = seed >>> 0 || 1;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 48271) % 0x7fffffff;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  it("yields identical rate vectors over 100 same-input runs", () => {
    const sigs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      sigs.add(ratesSignature(solveLp({ targets, pack }).rates));
    }
    expect(sigs.size).toBe(1);
  });

  it("is invariant to recipe-pack input order", () => {
    const baseline = ratesSignature(solveLp({ targets, pack }).rates);
    for (let seed = 1; seed <= 10; seed++) {
      const shuffled = {
        ...pack,
        recipes: shuffle(pack.recipes, seed),
        items: shuffle(pack.items, seed + 17),
      };
      const sig = ratesSignature(solveLp({ targets, pack: shuffled }).rates);
      expect(sig, `shuffle seed ${seed} drifted`).toBe(baseline);
    }
  });
});

describe("solveLp - precision (mass-balance residual)", () => {
  it("headline plan closes mass balance within 1ppm on finite-supply items", () => {
    const targets: ItemTarget[] = [
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
    ];
    const result = solveLp({ targets, pack });

    // For each finite-supply item: production - consumption + draw - surplus
    // + deficit must equal demand. Raw items have infinite supply, so skip them.
    const rate = (id: string) =>
      (result.rates.get(id)?.valueOf() ?? 0) as number;
    const demandOf = new Map<string, number>();
    for (const t of targets) {
      const d = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
      demandOf.set(t.itemId, (demandOf.get(t.itemId) ?? 0) + d);
    }

    for (const it of pack.items) {
      if (!it.raw) {
        let bal = 0;
        for (const r of pack.recipes) {
          const out = r.out.find((o) => o.item === it.id)?.qty ?? 0;
          const inq = r.in.find((i) => i.item === it.id)?.qty ?? 0;
          bal += (out - inq) * rate(r.id);
        }
        const surplus = result.surplus.get(it.id)?.valueOf() ?? 0;
        const deficit = result.deficit.get(it.id)?.valueOf() ?? 0;
        const draw = result.draws.get(it.id)?.valueOf() ?? 0;
        const residual =
          bal + draw - surplus + deficit - (demandOf.get(it.id) ?? 0);
        const scale = Math.max(1, Math.abs(demandOf.get(it.id) ?? 0));
        expect(
          Math.abs(residual) / scale,
          `mass-balance residual for ${it.id}`,
        ).toBeLessThan(1e-6);
      }
    }
  });
});

describe("solveLp - input guards", () => {
  it("clamps negative recipeCost overrides to avoid an unbounded objective", () => {
    const p = {
      recipes: [
        {
          id: "make_prod",
          category: "material",
          time: 1,
          in: [{ item: "raw_a", qty: 1 }],
          out: [{ item: "prod", qty: 1 }],
        },
      ],
      items: [
        { id: "raw_a", raw: true },
        { id: "prod", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: ItemTarget[] = [
      { itemId: "prod", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({
      targets,
      pack: p,
      recipeCosts: new Map([["make_prod", -5]]),
    });
    const x = result.rates.get("make_prod");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1))).toBe(true);
  });

  it("reports a deficit when the demanded item's only producer emits qty 0", () => {
    const p = {
      recipes: [
        {
          id: "zero_out",
          category: "material",
          time: 1,
          in: [{ item: "raw_a", qty: 1 }],
          out: [{ item: "prod", qty: 0 }],
        },
      ],
      items: [
        { id: "raw_a", raw: true },
        { id: "prod", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: ItemTarget[] = [
      { itemId: "prod", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    for (const v of result.rates.values()) {
      expect(Number.isFinite(v.valueOf())).toBe(true);
    }
    expect(result.deficit.get("prod")?.valueOf() ?? 0).toBeCloseTo(1, 6);
  });
});

describe("solveLp - multiple targets", () => {
  it("meets every item demand simultaneously", () => {
    const targets: ItemTarget[] = [
      { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      { itemId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
    ];
    const result = solveLp({ targets, pack });
    // Both items are produced by the recipe of the same id in the shipped
    // pack; each must run at >= demand / primary qty to cover its demand.
    for (const t of targets) {
      const recipe = pack.recipes.find((r) => r.id === t.itemId)!;
      const primary = recipe.out[0]!;
      const floor =
        Number(t.ratePerSec.num) / Number(t.ratePerSec.denom) / primary.qty;
      const x = result.rates.get(recipe.id);
      expect(x, `${recipe.id} must be active`).toBeDefined();
      expect(x!.valueOf()).toBeGreaterThanOrEqual(floor - 1e-9);
    }
  });

  it("sums demand across duplicate targets on the same item", () => {
    const p = {
      recipes: [
        {
          id: "prod_a",
          category: "material",
          time: 1,
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "shared", qty: 1 }],
        },
        {
          id: "prod_b",
          category: "material",
          time: 1,
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "shared", qty: 1 }],
        },
      ],
      items: [
        { id: "raw", raw: true },
        { id: "shared", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: ItemTarget[] = [
      { itemId: "shared", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "shared", ratePerSec: { num: "2", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    // Demand on `shared` sums to 1 + 2 = 3. The producers tie on cost, so the
    // pass-2 lex tie-break routes the whole demand through prod_a; no surplus
    // or deficit either way.
    expect(result.rates.get("prod_a")?.valueOf() ?? 0).toBeCloseTo(3, 6);
    expect(result.rates.has("prod_b")).toBe(false);
    expect(result.deficit.get("shared")?.valueOf() ?? 0).toBeCloseTo(0, 6);
    expect(result.surplus.get("shared")?.valueOf() ?? 0).toBeCloseTo(0, 6);
  });
});

describe("solveLp - duplicate targets", () => {
  it("sums duplicate target demand on the same item instead of overwriting", () => {
    // Two targets on `prod` (1/s and 2/s) must sum the item demand to 3; an
    // overwrite bug would leave it at 2. The cheaper alt covers the whole
    // summed demand.
    const p = {
      recipes: [
        {
          id: "make_prod",
          category: "material",
          time: 1,
          in: [{ item: "raw_a", qty: 1 }],
          out: [{ item: "prod", qty: 1 }],
        },
        {
          id: "alt",
          category: "material",
          time: 1,
          in: [{ item: "raw_a", qty: 1 }],
          out: [{ item: "prod", qty: 1 }],
        },
      ],
      items: [
        { id: "raw_a", raw: true },
        { id: "prod", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: ItemTarget[] = [
      { itemId: "prod", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "prod", ratePerSec: { num: "2", denom: "1" } },
    ];
    const result = solveLp({
      targets,
      pack: p,
      recipeCosts: new Map([["alt", 0.5]]),
    });
    const x = result.rates.get("alt");
    expect(x).toBeDefined();
    expect(x!.valueOf()).toBeCloseTo(3, 6);
    expect(result.rates.has("make_prod")).toBe(false);
  });
});

describe("solveLp - target over-production (free disposal)", () => {
  it("over-runs a target's producer when the co-product route is cheaper", () => {
    // make_p produces p (the headline) plus co-product c. make_thing needs c=6;
    // zz_make_c produces c=1 standalone. Item demand is a net-export floor, not
    // a production cap: covering make_thing's c demand by over-running make_p
    // (2 runs) is cheaper than three zz_make_c runs, and the extra unit of p
    // legitimately becomes free-disposal surplus.
    const p = {
      recipes: [
        {
          id: "make_p",
          category: "material",
          time: 1,
          in: [{ item: "raw", qty: 1 }],
          out: [
            { item: "p", qty: 1 },
            { item: "c", qty: 3 },
          ],
        },
        {
          id: "make_thing",
          category: "material",
          time: 1,
          in: [{ item: "c", qty: 6 }],
          out: [{ item: "thing", qty: 1 }],
        },
        {
          id: "zz_make_c",
          category: "material",
          time: 1,
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "c", qty: 1 }],
        },
      ],
      items: [
        { id: "raw", raw: true },
        { id: "p", raw: false },
        { id: "c", raw: false },
        { id: "thing", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: ItemTarget[] = [
      { itemId: "p", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "thing", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    const x = result.rates.get("make_p");
    expect(x).toBeDefined();
    // make_p over-runs to 2 (6 c from two runs beats three zz_make_c runs);
    // the p demand of 1 leaves a surplus of 1, disposed of for free.
    expect(x!.valueOf()).toBeCloseTo(2, 5);
    expect(result.rates.has("zz_make_c")).toBe(false);
    expect(result.surplus.get("p")?.valueOf() ?? 0).toBeCloseTo(1, 5);
    expect(result.softFeasible).toBe(true);
  });
});

describe("solveLp - status and softFeasible", () => {
  it("reports empty status and soft-feasible for no targets", () => {
    const result = solveLp({ targets: [], pack });
    expect(result.status).toBe("empty");
    expect(result.softFeasible).toBe(true);
  });

  it("reports soft-infeasible when the demanded item cannot be net-produced", () => {
    // make_prod's input "mid" is non-raw with no producer (finite supply 0).
    // Running make_prod only relocates the unavoidable 1-unit deficit from
    // "prod" onto "mid", so the deficit cost is flat in x and the engine may
    // stop at any point on that flat edge (it returns a small junk rate).
    // The honest contract: softFeasible false, the reported deficits cover
    // the demand exactly, and every row closes on the extracted point.
    const p = {
      recipes: [
        {
          id: "make_prod",
          category: "material",
          time: 1,
          in: [{ item: "mid", qty: 1 }],
          out: [{ item: "prod", qty: 1 }],
        },
      ],
      items: [
        { id: "prod", raw: false },
        { id: "mid", raw: false },
      ],
    } as unknown as RecipePack;
    const targets: ItemTarget[] = [
      { itemId: "prod", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.softFeasible).toBe(false);
    const prodDeficit = result.deficit.get("prod")?.valueOf() ?? 0;
    const midDeficit = result.deficit.get("mid")?.valueOf() ?? 0;
    expect(prodDeficit).toBeGreaterThan(0);
    expect(prodDeficit + midDeficit).toBeCloseTo(1, 6);
    expectExactlyBalanced(result, p, targets);
  });
});

describe("solveLp - tiny rates (sub-1e-6 extraction)", () => {
  it("keeps a tiny target demand instead of snapping it to zero", () => {
    const p = makePack(
      [{ id: "a", time: 1, in: { R: 1 }, out: { F: 1 } }],
      [
        { id: "F", stack: 1 },
        { id: "R", raw: true, stack: 1 },
      ],
    );
    const targets: ItemTarget[] = [
      { itemId: "F", ratePerSec: { num: "1", denom: "10000000" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.status).toBe("feasible");
    const x = result.rates.get("a");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1, 10000000))).toBe(true);
    expect(result.softFeasible).toBe(true);
  });

  it("reports a material deficit for an unmeetable demand at a tiny rate", () => {
    // a's input X has no producer and no external supply, so the F demand is
    // unmeetable; the solver pays the 1e9 deficit penalty on the demanded item.
    // softFeasible must come from that raw signal, not from a deficit map
    // censored by an absolute snap.
    const p = makePack(
      [{ id: "a", time: 1, in: { X: 1 }, out: { F: 1 } }],
      [
        { id: "F", stack: 1 },
        { id: "X", stack: 1 },
      ],
    );
    const targets: ItemTarget[] = [
      { itemId: "F", ratePerSec: { num: "1", denom: "10000000" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.softFeasible).toBe(false);
    const dx = result.deficit.get("F");
    expect(dx).toBeDefined();
    expect(dx!.equals(new Fraction(1, 10000000))).toBe(true);
  });
});

describe("solveLp - small-demand extraction", () => {
  it("closes every finite-supply row exactly at a 1/1500 demand", () => {
    // Sub-unit demand with awkward ratios (M 3:2). The engine rounds primals
    // to ~1e-8 absolute, which at this magnitude exceeds the relative snap
    // radius, so the extracted point can carry sub-material drift the repair
    // loop cannot close (surfaced honestly as a tiny deficit; the known
    // small-rate false-negative family). The invariant: the reported point is
    // self-consistent (every row closes exactly), the drift stays far below
    // the demand, and softFeasible agrees with the deficit map.
    const p = makePack(
      [
        { id: "a", time: 1, in: { M: 3 }, out: { F: 1 } },
        { id: "b", time: 1, in: { R: 7 }, out: { M: 2 } },
      ],
      [
        { id: "F", stack: 1 },
        { id: "M", stack: 1 },
        { id: "R", raw: true, stack: 1 },
      ],
    );
    const targets: ItemTarget[] = [
      { itemId: "F", ratePerSec: { num: "1", denom: "1500" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.softFeasible).toBe(result.deficit.size === 0);
    let drift = 0;
    for (const v of result.deficit.values()) drift += v.valueOf();
    expect(drift).toBeLessThan(1e-7);
    expectExactlyBalanced(result, p, targets);
  });

  it("real pack: bottled_food_1 at 0.1/s is met and closes rows exactly", () => {
    const targets: ItemTarget[] = [
      { itemId: "bottled_food_1", ratePerSec: { num: "1", denom: "10" } },
    ];
    const result = solveLp({ targets, pack });
    expect(result.softFeasible).toBe(true);
    expect(result.deficit.size).toBe(0);
    expectExactlyBalanced(result, pack, targets);
  });
});

describe("solveLp - phantom epsilon chains", () => {
  it("drops the dangling crystal chain from the multi-target xiranite plan", () => {
    // The raw solve carries crystal_powder-crystal_shell and
    // crystal_shell-originium_ore at ~1/900900 (1.11e-6, just above the old
    // absolute snap radius) with no positive-rate consumer of the chain's net
    // output: a mass-balance violation baked into the extracted point. The
    // noise sweep must remove both, and every finite-supply row must close
    // exactly.
    const targets: ItemTarget[] = [
      { itemId: "liquid_xiranite_poly", ratePerSec: { num: "2", denom: "1" } },
      { itemId: "equip_script_4", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack });
    expect(result.rates.has("crystal_powder-crystal_shell")).toBe(false);
    expect(result.rates.has("crystal_shell-originium_ore")).toBe(false);
    expectExactlyBalanced(result, pack, targets);
  });

  it("control: equip_script_4@1/s keeps exactly the pre-hygiene support set", () => {
    // Anchored epsilon chains (a live consumer covers the chain head's output)
    // must not survive the relative snap: the support set of this plan is
    // pinned so flow-anchored junk cannot land silently.
    const targets: ItemTarget[] = [
      { itemId: "equip_script_4", ratePerSec: { num: "1", denom: "1" } },
    ];
    // game v1.4: the LP sources xiranite_powder through the gas route
    // (phase_trans_2 fed by boundary gas_xiranite), which retires the carbon
    // and plant_grass legs the pre-v1.4 support carried.
    const result = solveLp({ targets, pack });
    expect([...result.rates.keys()].sort()).toEqual([
      "crystal_enr",
      "crystal_enr_powder-originium_enr_powder",
      "equip_script_4",
      "originium_enr_powder",
      "originium_powder",
      "phase_trans_2-xiranite_powder",
      "plant_moss_3",
      "plant_moss_powder_3",
      "plant_moss_seed_3",
    ]);
  });
});

describe("solveLp - bounded supply draw", () => {
  // a: 1 M -> 1 F. M is non-raw with a finite supply cap. The cap is a bounded
  // draw variable (0..cap), not a forced injection: the LP draws exactly what
  // it consumes and the unconsumed cap remainder produces no phantom surplus.
  const capPack = makePack(
    [{ id: "a", time: 1, in: { M: 1 }, out: { F: 1 } }],
    [
      { id: "F", stack: 1 },
      { id: "M", stack: 1 },
    ],
  );
  const capTargets: ItemTarget[] = [
    { itemId: "F", ratePerSec: { num: "4", denom: "1" } },
  ];

  it("draws exactly what is consumed when the cap exceeds need", () => {
    const overrides: ItemOverride[] = [
      { itemId: "M", ratePerSec: { num: "10", denom: "1" } },
    ];
    const result = solveLp({
      targets: capTargets,
      pack: capPack,
      itemOverrides: overrides,
    });
    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    expect(result.rates.get("a")!.equals(4)).toBe(true);
    // No phantom cap-minus-need surplus on M.
    expect(result.surplus.get("M")?.valueOf() ?? 0).toBe(0);
    expect(result.draws.get("M")!.equals(4)).toBe(true);
    expectExactlyBalanced(result, capPack, capTargets, overrides);
  });

  it("keeps the draw within a huge cap instead of injecting it", () => {
    const overrides: ItemOverride[] = [
      { itemId: "M", ratePerSec: { num: "1000000", denom: "1" } },
    ];
    const result = solveLp({
      targets: capTargets,
      pack: capPack,
      itemOverrides: overrides,
    });
    expect(result.status).toBe("feasible");
    expect(result.draws.get("M")!.equals(4)).toBe(true);
    expect(result.surplus.get("M")?.valueOf() ?? 0).toBe(0);
    expectExactlyBalanced(result, capPack, capTargets, overrides);
  });

  it("draws up to the cap and produces the remainder when the cap is below demand", () => {
    const p = makePack(
      [
        { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
        { id: "b", time: 1, in: { R: 1 }, out: { M: 1 } },
      ],
      [
        { id: "F", stack: 1 },
        { id: "M", stack: 1 },
        { id: "R", raw: true, stack: 1 },
      ],
    );
    const overrides: ItemOverride[] = [
      { itemId: "M", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({
      targets: capTargets,
      pack: p,
      itemOverrides: overrides,
    });
    expect(result.status).toBe("feasible");
    expect(result.rates.get("a")!.equals(4)).toBe(true);
    // The free draw substitutes for production first; b covers the remainder.
    expect(result.rates.get("b")!.equals(3)).toBe(true);
    // Draw snaps to the exact cap Fraction.
    expect(result.draws.get("M")!.equals(1)).toBe(true);
    expectExactlyBalanced(result, p, capTargets, overrides);
  });

  it("keeps the draw at the LP value below the cap when byproduct production covers part of demand", () => {
    // main runs at 4 to meet the P demand and co-produces M at 4; zz_use
    // consumes M at 8. The draw covers only the uncovered 4, NOT
    // min(cap, demand) = 8: drawing more would force the byproduct into
    // costed surplus.
    const p = makePack(
      [
        { id: "main", time: 1, in: { R: 1 }, out: { P: 1, M: 1 } },
        { id: "zz_use", time: 1, in: { M: 2 }, out: { Q: 1 } },
      ],
      [
        { id: "P", stack: 1 },
        { id: "M", stack: 1 },
        { id: "Q", stack: 1 },
        { id: "R", raw: true, stack: 1 },
      ],
    );
    const targets: ItemTarget[] = [
      { itemId: "P", ratePerSec: { num: "4", denom: "1" } },
      { itemId: "Q", ratePerSec: { num: "4", denom: "1" } },
    ];
    const overrides: ItemOverride[] = [
      { itemId: "M", ratePerSec: { num: "10", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p, itemOverrides: overrides });
    expect(result.status).toBe("feasible");
    expect(result.rates.get("main")!.equals(4)).toBe(true);
    expect(result.rates.get("zz_use")!.equals(4)).toBe(true);
    expect(result.draws.get("M")!.equals(4)).toBe(true);
    expectExactlyBalanced(result, p, targets, overrides);
  });

  it("serves a targeted DUAL item's demand from the free draw first", () => {
    // glass_enr_bottle targeted at 2/s with a finite cap on the same item: an
    // external draw of the target item counts toward the net-export demand
    // and costs nothing, so the LP draws min(cap, demand) and produces only
    // the remainder.
    const targets: ItemTarget[] = [
      { itemId: "glass_enr_bottle", ratePerSec: { num: "2", denom: "1" } },
    ];
    for (const [num, denom, expectedDraw] of [
      ["10", "1", "2"],
      ["2", "1", "2"],
      ["1", "1", "1"],
      ["1", "100", "1/100"],
    ] as const) {
      const overrides: ItemOverride[] = [
        { itemId: "glass_enr_bottle", ratePerSec: { num, denom } },
      ];
      const result = solveLp({ targets, pack, itemOverrides: overrides });
      expect(result.softFeasible, `cap ${num}/${denom} must be met`).toBe(true);
      expect(result.deficit.size).toBe(0);
      const draw = result.draws.get("glass_enr_bottle") ?? new Fraction(0);
      expect(
        draw.equals(new Fraction(expectedDraw)),
        `cap ${num}/${denom}: draw ${draw.toFraction()}`,
      ).toBe(true);
      expectExactlyBalanced(result, pack, targets, overrides);
    }
  });

  it("meets the whole demand from the draw when the cap covers it", () => {
    // Cap 10/s on the targeted plant_moss_seed_1: the free external draw
    // covers the whole 2/s net-export demand, so nothing needs to run at all.
    // Control (no override) produces the seed internally.
    const targets: ItemTarget[] = [
      { itemId: "plant_moss_seed_1", ratePerSec: { num: "2", denom: "1" } },
    ];
    const overrides: ItemOverride[] = [
      { itemId: "plant_moss_seed_1", ratePerSec: { num: "10", denom: "1" } },
    ];
    const control = solveLp({ targets, pack });
    expect(
      (control.rates.get("plant_moss_seed_1")?.valueOf() ?? 0) > 0,
    ).toBe(true);
    const result = solveLp({ targets, pack, itemOverrides: overrides });
    expect(result.status).toBe("empty");
    expect(result.rates.size).toBe(0);
    expect(result.draws.get("plant_moss_seed_1")!.equals(2)).toBe(true);
    expect(result.surplus.size).toBe(0);
    expectExactlyBalanced(result, pack, targets, overrides);
  });

  it("drops the draw when the noise sweep zeroes the cap item's only consumer", () => {
    // rMain anchors the plan scale at 1e6 (noise ceiling 100, T's repair
    // tolerance 1). rEps is the only consumer of capped M (cap 1/2); it covers
    // part of the T demand at a rate below the ceiling, so the sweep zeroes
    // it and the repair loop leaves it zeroed (T's 0.5 shortfall sits under
    // its tolerance). The M draw must go with its consumer: an orphaned draw
    // reports a pull the surviving solution never consumes and would leak
    // into surplus.
    const p = makePack(
      [
        { id: "rEps", time: 1, in: { M: 1 }, out: { T: 1 } },
        { id: "rMain", time: 1, in: { R: 1 }, out: { T: 1 } },
        { id: "rUse", time: 1, in: { T: 1 }, out: { U: 1 } },
      ],
      [
        { id: "M", stack: 1 },
        { id: "R", raw: true, stack: 1 },
        { id: "T", stack: 1 },
        { id: "U", stack: 1 },
      ],
    );
    const targets: ItemTarget[] = [
      { itemId: "T", ratePerSec: { num: "1000000", denom: "1" } },
      { itemId: "U", ratePerSec: { num: "1", denom: "2" } },
    ];
    const result = solveLp({
      targets,
      pack: p,
      itemOverrides: [{ itemId: "M", ratePerSec: { num: "1", denom: "2" } }],
      // Free rEps so the LP covers the marginal T from the capped draw
      // instead of raising rMain.
      recipeCosts: new Map([["rEps", 0]]),
    });
    expect(result.status).toBe("feasible");
    // The sweep removed the epsilon consumer.
    expect(result.rates.has("rEps")).toBe(false);
    // The draw it anchored must not survive it, nor leak into surplus.
    expect(result.draws.has("M")).toBe(false);
    expect(result.surplus.get("M")?.valueOf() ?? 0).toBe(0);
  });

  it("keeps a demand-bearing draw with no surviving consumer", () => {
    // Demand on T with no working producer (rBad emits it at qty 0) and a
    // finite cap on T itself: the capped draw is the sole supply meeting T's
    // demand. The orphan-draw drop must NOT remove it: dropping it would
    // silently unmeet the demand and leave an unreported negative-slack
    // residual.
    const p = makePack(
      [
        { id: "rMain", time: 1, in: { R: 1 }, out: { F: 1 } },
        { id: "rBad", time: 1, in: { R: 1 }, out: { T: 0 } },
      ],
      [
        { id: "R", raw: true, stack: 1 },
        { id: "F", stack: 1 },
        { id: "T", stack: 1 },
      ],
    );
    const result = solveLp({
      targets: [
        { itemId: "F", ratePerSec: { num: "1", denom: "1" } },
        { itemId: "T", ratePerSec: { num: "1", denom: "1" } },
      ],
      pack: p,
      itemOverrides: [{ itemId: "T", ratePerSec: { num: "1", denom: "1" } }],
    });
    expect(result.status).toBe("feasible");
    // The draw feeding T's demand survives, exactly matching the demand.
    expect(result.draws.get("T")?.valueOf() ?? 0).toBe(1);
    // No spurious surplus or deficit, and the demand is reported as met.
    expect(result.surplus.has("T")).toBe(false);
    expect(result.deficit.has("T")).toBe(false);
    expect(result.softFeasible).toBe(true);
  });

  it("emits no draw entries without finite positive caps", () => {
    const noOverride = solveLp({ targets: capTargets, pack: capPack });
    expect(noOverride.draws.size).toBe(0);
    // A cap of 0 forces internal build (here: deficit) and emits no draw.
    const zeroCap = solveLp({
      targets: capTargets,
      pack: capPack,
      itemOverrides: [{ itemId: "M", ratePerSec: { num: "0", denom: "1" } }],
    });
    expect(zeroCap.draws.size).toBe(0);
    expect(zeroCap.softFeasible).toBe(false);
  });
});

// An extraction recipe consumes nothing - a miner or a pump. A plan imports
// raw material over the boundary instead of building one, so no solution may
// run one at any rate. The ban is structural, not a cost preference: it holds
// even when running the extractor is the only way to meet demand, in which
// case the shortfall must surface as a deficit.
//
// Only a raw item with FINITE supply reaches this. An uncapped raw item gets
// no mass-balance row at all, so its extractor sits at zero whatever the cost
// model says; a rate cap or a `plan: true` override is what makes the row
// exist and the miner attractive.
describe("solveLp - extraction recipes", () => {
  // mine: -> 1 M (an extractor). a: 1 M -> 1 F. M is raw, so only an override
  // gives it a mass-balance row.
  const minePack = makePack(
    [
      { id: "mine", time: 1, in: {}, out: { M: 1 } },
      { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
    ],
    [
      { id: "F", stack: 1 },
      { id: "M", raw: true, stack: 1 },
    ],
  );
  const mineTargets: ItemTarget[] = [
    { itemId: "F", ratePerSec: { num: "4", denom: "1" } },
  ];

  it("reports a deficit rather than mining the gap above a rate cap", () => {
    const overrides: ItemOverride[] = [
      { itemId: "M", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({
      targets: mineTargets,
      pack: minePack,
      itemOverrides: overrides,
    });
    expect(result.status).toBe("feasible");
    expect(result.rates.has("mine")).toBe(false);
    // The cap supplies 1/s of the 4/s the target needs; the rest is unmet.
    expect(result.draws.get("M")!.equals(1)).toBe(true);
    expect(result.softFeasible).toBe(false);
    expect(result.deficit.get("F")!.equals(3)).toBe(true);
    expectExactlyBalanced(result, minePack, mineTargets, overrides);
  });

  it("leaves the extractor out under a plan:true override too", () => {
    const result = solveLp({
      targets: mineTargets,
      pack: minePack,
      itemOverrides: [{ itemId: "M", plan: true }],
    });
    expect(result.rates.has("mine")).toBe(false);
    expect(result.softFeasible).toBe(false);
  });

  // End-to-end pin of the reported case on the shipped pack: capping the water
  // the plan drinks used to run the liquid_water pump at 3/s to cover the rest.
  // `in.length === 0` is spelled out rather than calling isExtractionRecipe so
  // the assertion tracks the rule the ban owes its users, not its own
  // implementation.
  it("runs no input-less recipe of the real pack", () => {
    const extractors = pack.recipes
      .filter((r) => r.in.length === 0)
      .map((r) => r.id);
    // Guards the premise: a pack with no extractor would pass vacuously.
    expect(extractors.length).toBeGreaterThan(0);
    const result = solveLp({
      targets: [
        { itemId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
      ],
      pack,
      itemOverrides: [
        { itemId: "liquid_water", ratePerSec: { num: "1", denom: "1" } },
      ],
    });
    expect([...result.rates.keys()].filter((id) => extractors.includes(id))).toEqual([]);
    // The pack has other water sources, so the plan reroutes rather than going
    // short: banning the pump is not the same as breaking a plan.
    expect(result.softFeasible).toBe(true);
  });
});
