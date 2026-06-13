import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp, type LpResult } from "./lp";
import { makePack } from "./closed-form-fixtures";
import { effectiveSupply } from "./effectiveSupply";
import { pack } from "../data/load";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipePack } from "@aef/schema";

// Exact per-item mass-balance residual over the extracted result:
// production - consumption + draw - surplus + deficit - demand, in Fraction
// arithmetic, for every finite-supply item. The extraction recomputes
// surplus/deficit from the final rates, so a hygienic result closes every row
// to exactly zero.
function exactResiduals(
  result: LpResult,
  p: RecipePack,
  targets: Target[],
  overrides: ItemOverride[] = [],
): Map<string, Fraction> {
  const zero = new Fraction(0);
  const demand = new Map<string, Fraction>();
  for (const t of targets) {
    const recipe = p.recipes.find((r) => r.id === t.recipeId);
    if (!recipe || recipe.out.length === 0) continue;
    const item = recipe.out[0]!.item;
    const rate = new Fraction(`${t.ratePerSec.num}/${t.ratePerSec.denom}`);
    demand.set(item, (demand.get(item) ?? zero).add(rate));
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
  targets: Target[],
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

describe("solveLp - single-recipe pin", () => {
  it("pins a single acyclic target at the requested rate", () => {
    const targets: Target[] = [
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "60" } },
    ];
    const result = solveLp({ targets, pack });
    const x = result.rates.get("copper_powder");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1, 60))).toBe(true);
  });
});

describe("solveLp - headline (4:1 purifier)", () => {
  const targets: Target[] = [
    { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
  ];

  it("pins the target at 6/min (0.1 enr_powder/sec)", () => {
    const result = solveLp({ targets, pack });
    const xEnr = result.rates.get("xiranite_enr_powder");
    expect(xEnr).toBeDefined();
    expect(xEnr!.equals(new Fraction(1, 10))).toBe(true);
  });

  it("runs the main and purifier recipes at a 4:1 ratio", () => {
    const result = solveLp({ targets, pack });
    const xMain = result.rates.get("liquid_xiranite_poly");
    const xPurifier = result.rates.get("liquid_xiranite_poly-purifier");
    expect(xMain, "main liquid_xiranite_poly must be active").toBeDefined();
    expect(xPurifier, "purifier must be active").toBeDefined();
    expect(xMain!.equals(new Fraction(2, 5))).toBe(true); // 0.4/sec
    expect(xPurifier!.equals(new Fraction(1, 10))).toBe(true); // 0.1/sec
  });

  it("produces zero liquid_xiranite_lowpoly surplus", () => {
    const result = solveLp({ targets, pack });
    const lowpoly = result.surplus.get("liquid_xiranite_lowpoly");
    if (lowpoly !== undefined) expect(lowpoly.equals(0)).toBe(true);
  });
});

describe("solveLp - determinism", () => {
  const targets: Target[] = [
    { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
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
    const targets: Target[] = [
      { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
    ];
    const result = solveLp({ targets, pack });

    // For each finite-supply item: production - consumption + draw - surplus
    // + deficit must equal demand. Raw items have infinite supply, so skip them.
    const rate = (id: string) =>
      (result.rates.get(id)?.valueOf() ?? 0) as number;
    const demandOf = new Map<string, number>();
    for (const t of targets) {
      const r = pack.recipes.find((x) => x.id === t.recipeId)!;
      const prim = r.out[0]!;
      const d = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
      demandOf.set(prim.item, (demandOf.get(prim.item) ?? 0) + d);
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
    const targets: Target[] = [
      { recipeId: "make_prod", ratePerSec: { num: "1", denom: "1" } },
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

  it("skips the target pin when the primary output qty is 0", () => {
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
    const targets: Target[] = [
      { recipeId: "zero_out", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    for (const v of result.rates.values()) {
      expect(Number.isFinite(v.valueOf())).toBe(true);
    }
    expect(result.deficit.get("prod")?.valueOf() ?? 0).toBeCloseTo(1, 6);
  });
});

describe("solveLp - multiple targets", () => {
  it("pins every target simultaneously", () => {
    const targets: Target[] = [
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      { recipeId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
    ];
    const result = solveLp({ targets, pack });
    for (const t of targets) {
      const recipe = pack.recipes.find((r) => r.id === t.recipeId)!;
      const primary = recipe.out[0]!;
      const floor =
        Number(t.ratePerSec.num) / Number(t.ratePerSec.denom) / primary.qty;
      const x = result.rates.get(t.recipeId);
      expect(x, `${t.recipeId} must be active`).toBeDefined();
      expect(x!.valueOf()).toBeGreaterThanOrEqual(floor - 1e-9);
    }
  });

  it("sums demand when two distinct target recipes share a primary output item", () => {
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
    const targets: Target[] = [
      { recipeId: "prod_a", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "prod_b", ratePerSec: { num: "2", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    // Demand on `shared` sums to 1 + 2 = 3, met by both producers at their
    // pinned floors with no surplus or deficit.
    expect(result.rates.get("prod_a")?.valueOf() ?? 0).toBeCloseTo(1, 6);
    expect(result.rates.get("prod_b")?.valueOf() ?? 0).toBeCloseTo(2, 6);
    expect(result.deficit.get("shared")?.valueOf() ?? 0).toBeCloseTo(0, 6);
    expect(result.surplus.get("shared")?.valueOf() ?? 0).toBeCloseTo(0, 6);
  });
});

describe("solveLp - duplicate targets", () => {
  it("sums duplicate target floors on the same recipe instead of overwriting", () => {
    // make_prod (the target) and the cheaper alt both produce `prod`, so the LP
    // prefers alt for any demand not pinned onto make_prod. Two make_prod
    // targets (1/s and 2/s) must sum the pin floor to 3; the old overwrite bug
    // left it at 2 and let alt cover the remaining 1.
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
    const targets: Target[] = [
      { recipeId: "make_prod", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "make_prod", ratePerSec: { num: "2", denom: "1" } },
    ];
    const result = solveLp({
      targets,
      pack: p,
      recipeCosts: new Map([["alt", 0.5]]),
    });
    const x = result.rates.get("make_prod");
    expect(x).toBeDefined();
    expect(x!.valueOf()).toBeCloseTo(3, 6);
  });
});

describe("solveLp - headline over-production", () => {
  it("holds a target at its floor when a co-product could subsidize over-running it", () => {
    // make_p produces p (the headline) plus co-product c. make_thing needs c=6;
    // zz_make_c produces c=1 standalone. With only a one-sided floor, the LP
    // covers make_thing's c demand by over-running make_p (cheaper than three
    // zz_make_c runs), silently producing p surplus. The surplus cap on the
    // headline item must hold make_p at its floor of x=1. zz_make_c is named to
    // lex-sort after make_p so the pass-2 lex tie-break doesn't incidentally
    // dodge the over-production the cap is meant to prevent.
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
    const targets: Target[] = [
      { recipeId: "make_p", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "make_thing", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    const x = result.rates.get("make_p");
    expect(x).toBeDefined();
    // make_p must sit at its floor of 1, not over-run to 2. The cap carries a
    // tiny relative eps so the value may exceed 1 by ~1e-6; assert near-floor
    // within that slack, not exactly 1.
    expect(x!.valueOf()).toBeCloseTo(1, 5);
    expect(result.surplus.get("p")?.valueOf() ?? 0).toBeCloseTo(0, 5);
  });
});

describe("solveLp - status and softFeasible", () => {
  it("reports empty status and soft-feasible for no targets", () => {
    const result = solveLp({ targets: [], pack });
    expect(result.status).toBe("empty");
    expect(result.softFeasible).toBe(true);
  });

  it("reports soft-infeasible when an input has no producer", () => {
    // make_prod runs at the pinned rate (positive rate => status "feasible"),
    // but its input "mid" is non-raw with no producer (finite supply 0), so the
    // LP covers mid via a deficit var. That makes the LP feasible but not
    // softFeasible: the deficit survives the demand-met check.
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
    const targets: Target[] = [
      { recipeId: "make_prod", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.rates.get("make_prod")?.valueOf() ?? 0).toBeCloseTo(1, 6);
    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(false);
    expect(result.deficit.get("mid")?.valueOf() ?? 0).toBeCloseTo(1, 6);
  });
});

describe("solveLp - tiny rates (sub-1e-6 extraction)", () => {
  it("keeps a tiny pinned target rate instead of snapping it to zero", () => {
    const p = makePack(
      [{ id: "a", time: 1, in: { R: 1 }, out: { F: 1 } }],
      [
        { id: "F", stack: 1 },
        { id: "R", raw: true, stack: 1 },
      ],
    );
    const targets: Target[] = [
      { recipeId: "a", ratePerSec: { num: "1", denom: "10000000" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.status).toBe("feasible");
    const x = result.rates.get("a");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1, 10000000))).toBe(true);
    expect(result.softFeasible).toBe(true);
  });

  it("reports a material deficit for an unproducible input at a tiny rate", () => {
    // X has no producer and no external supply; the solver pays the 1e9 deficit
    // penalty for it. softFeasible must come from that raw signal, not from a
    // deficit map censored by an absolute snap.
    const p = makePack(
      [{ id: "a", time: 1, in: { X: 1 }, out: { F: 1 } }],
      [
        { id: "F", stack: 1 },
        { id: "X", stack: 1 },
      ],
    );
    const targets: Target[] = [
      { recipeId: "a", ratePerSec: { num: "1", denom: "10000000" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.softFeasible).toBe(false);
    const dx = result.deficit.get("X");
    expect(dx).toBeDefined();
    expect(dx!.equals(new Fraction(1, 10000000))).toBe(true);
  });
});

describe("solveLp - exact pin-floor extraction", () => {
  it("snaps the pinned rate onto the exact floor 1/1500, not a nearby rational", () => {
    // The raw float primal sits ~4.5e-7 above 1/1500, inside the solver's
    // internal tolerance; a floor-blind snap lands on 1/1499. The extraction
    // must recognize the pin floor and return it exactly, and the recomputed
    // surplus must close every finite-supply row exactly.
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
    const targets: Target[] = [
      { recipeId: "a", ratePerSec: { num: "1", denom: "1500" } },
    ];
    const result = solveLp({ targets, pack: p });
    const x = result.rates.get("a");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1, 1500))).toBe(true);
    expectExactlyBalanced(result, p, targets);
  });

  it("real pack: qty-150 transfer at 0.1/s extracts exactly the 1/1500 floor", () => {
    // transfer_tundra_bottled_food_1 outputs 150 bottled_food_1 per execution,
    // so a 0.1/s target pins the floor at 1/1500. The wrong-rational class
    // (1/1499) was the dominant solver-residual value in the pairwise sweep.
    const targets: Target[] = [
      {
        recipeId: "transfer_tundra_bottled_food_1",
        ratePerSec: { num: "1", denom: "10" },
      },
    ];
    const result = solveLp({ targets, pack });
    const x = result.rates.get("transfer_tundra_bottled_food_1");
    expect(x).toBeDefined();
    expect(x!.equals(new Fraction(1, 1500))).toBe(true);
  });
});

describe("solveLp - phantom epsilon chains", () => {
  it("drops the dangling crystal chain from the triple-target xiranite plan", () => {
    // The raw solve carries crystal_powder-crystal_shell and
    // crystal_shell-originium_ore at ~1/900900 (1.11e-6, just above the old
    // absolute snap radius) with no positive-rate consumer of the chain's net
    // output: a mass-balance violation baked into the extracted point. The
    // noise sweep must remove both, and every finite-supply row must close
    // exactly.
    const targets: Target[] = [
      {
        recipeId: "liquid_xiranite_poly-purifier",
        ratePerSec: { num: "1", denom: "1" },
      },
      { recipeId: "liquid_xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "equip_script_4", ratePerSec: { num: "1", denom: "1" } },
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
    const targets: Target[] = [
      { recipeId: "equip_script_4", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack });
    expect([...result.rates.keys()].sort()).toEqual([
      "carbon_enr",
      "carbon_enr_powder-carbon_powder",
      "carbon_mtl-plant_grass_1",
      "carbon_powder-carbon_mtl",
      "crystal_enr",
      "crystal_enr_powder-originium_enr_powder",
      "equip_script_4",
      "originium_enr_powder",
      "originium_powder",
      "plant_grass_1",
      "plant_grass_seed_1",
      "plant_moss_3",
      "plant_moss_powder_3",
      "plant_moss_seed_3",
      "xiranite_powder",
    ]);
  });
});

describe("solveLp - infeasible result contract", () => {
  it("returns empty maps and softFeasible:false on a pinned-infeasible solve", () => {
    // rB forces 50 X/s co-product while the target on rX caps X's surplus at
    // ~eps: infeasible BY the pinned surplus-cap contract (overproduce-and-
    // discard is deliberately rejected). The raw solver object carries junk
    // partial values; none of it may leak into the result maps.
    const p = makePack(
      [
        { id: "rB", time: 1, in: { R: 1 }, out: { B: 1, X: 5 } },
        { id: "rX", time: 1, in: { S: 1 }, out: { X: 1 } },
      ],
      [
        { id: "B", stack: 1 },
        { id: "X", stack: 1 },
        { id: "R", raw: true, stack: 1 },
        { id: "S", raw: true, stack: 1 },
      ],
    );
    const targets: Target[] = [
      { recipeId: "rB", ratePerSec: { num: "10", denom: "1" } },
      { recipeId: "rX", ratePerSec: { num: "1", denom: "1" } },
    ];
    const result = solveLp({ targets, pack: p });
    expect(result.status).toBe("infeasible");
    expect(result.softFeasible).toBe(false);
    expect(result.rates.size).toBe(0);
    expect(result.surplus.size).toBe(0);
    expect(result.deficit.size).toBe(0);
    expect(result.draws.size).toBe(0);
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
  const capTargets: Target[] = [
    { recipeId: "a", ratePerSec: { num: "4", denom: "1" } },
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
    // main is pinned at 4 by its P target and co-produces M at 4; zz_use
    // consumes M at 8. The draw covers only the uncovered 4, NOT
    // min(cap, demand) = 8: drawing more would force the forced byproduct
    // into costed surplus.
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
    const targets: Target[] = [
      { recipeId: "main", ratePerSec: { num: "4", denom: "1" } },
      { recipeId: "zz_use", ratePerSec: { num: "4", denom: "1" } },
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

  it("is feasible for every cap value on a targeted DUAL item with no other consumer", () => {
    // glass_enr_bottle targeted at 2/s with a finite cap on the same item: the
    // pin floor is satisfied by production and the LP keeps draw at 0 because
    // a positive draw could only exit through the eps-capped surplus. Under
    // the old forced-injection row this was hard-infeasible for every cap.
    const targets: Target[] = [
      { recipeId: "glass_enr_bottle", ratePerSec: { num: "2", denom: "1" } },
    ];
    for (const [num, denom] of [
      ["10", "1"],
      ["2", "1"],
      ["1", "1"],
      ["1", "100"],
    ] as const) {
      const overrides: ItemOverride[] = [
        { itemId: "glass_enr_bottle", ratePerSec: { num, denom } },
      ];
      const result = solveLp({ targets, pack, itemOverrides: overrides });
      expect(result.status, `cap ${num}/${denom} must be feasible`).toBe(
        "feasible",
      );
      const x = result.rates.get("glass_enr_bottle");
      expect(x).toBeDefined();
      expect(x!.valueOf()).toBeGreaterThanOrEqual(2);
      expect(result.draws.get("glass_enr_bottle")?.valueOf() ?? 0).toBe(0);
      // Pinned disposal-absorber contract intact: surplus stays within the
      // surpcap eps (max(floor, 1) * 1e-7 = 2e-7).
      expect(
        result.surplus.get("glass_enr_bottle")?.valueOf() ?? 0,
      ).toBeLessThanOrEqual(2e-7);
    }
  });

  it("does not recruit consumers to launder a forced inflow", () => {
    // Cap 10/s on the targeted plant_moss_seed_1: the old forced injection
    // recruited plant_moss_1 at 10 exec/s (x20 machines) purely to consume the
    // inflow. Under the bounded draw nothing is forced in; the LP uses the
    // free external supply in place of internal cycle production (the drawn
    // seed feeds plant_moss_1's consumption), so the seed/moss cycle drops to
    // the pin floor: seed at 1 (rate 2 / out qty 2), moss at 1, draw exactly
    // the cycle's internal seed consumption of 1. Control (no override) runs
    // both at 2.
    const targets: Target[] = [
      { recipeId: "plant_moss_seed_1", ratePerSec: { num: "2", denom: "1" } },
    ];
    const overrides: ItemOverride[] = [
      { itemId: "plant_moss_seed_1", ratePerSec: { num: "10", denom: "1" } },
    ];
    const control = solveLp({ targets, pack });
    expect(control.rates.get("plant_moss_1")!.equals(2)).toBe(true);
    expect(control.rates.get("plant_moss_seed_1")!.equals(2)).toBe(true);
    const result = solveLp({ targets, pack, itemOverrides: overrides });
    expect(result.status).toBe("feasible");
    expect(result.rates.get("plant_moss_seed_1")!.equals(1)).toBe(true);
    expect(result.rates.get("plant_moss_1")!.equals(1)).toBe(true);
    expect(result.draws.get("plant_moss_seed_1")!.equals(1)).toBe(true);
    expect(result.surplus.size).toBe(0);
    expectExactlyBalanced(result, pack, targets, overrides);
  });

  it("drops the draw when the noise sweep zeroes the cap item's only consumer", () => {
    // rMain anchors the plan scale at 1e6 (noise ceiling 100, T's repair
    // tolerance 1). rEps is the only consumer of capped M; it covers rUse's
    // 0.5/s side draw on T at a rate below the ceiling, so the sweep zeroes
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
    const targets: Target[] = [
      { recipeId: "rMain", ratePerSec: { num: "1000000", denom: "1" } },
      { recipeId: "rUse", ratePerSec: { num: "1", denom: "2" } },
    ];
    const result = solveLp({
      targets,
      pack: p,
      itemOverrides: [{ itemId: "M", ratePerSec: { num: "5", denom: "1" } }],
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
    // rBad's primary out qty is 0, so it gets no pin floor and no surplus cap
    // (the malformed-data guard in the pin block), yet its target still
    // registers demand on T. No recipe consumes T and rBad produces none, so
    // the capped draw is the sole supply meeting T's demand. The orphan-draw
    // drop must NOT remove it: dropping it would silently unmeet the demand and
    // leave an unreported negative-slack residual. (For a well-formed target the
    // pin floor + surplus cap squeeze any draw on a demanded item to ~0, so this
    // malformed corner is the only path that reaches a demand-bearing draw.)
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
        { recipeId: "rMain", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "rBad", ratePerSec: { num: "1", denom: "1" } },
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
