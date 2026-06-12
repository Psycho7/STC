import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp, type LpResult } from "./lp";
import { makePack } from "./closed-form-fixtures";
import { effectiveSupply } from "./effectiveSupply";
import { pack } from "../data/load";
import type { Target } from "../data/targets";
import type { RecipePack } from "@aef/schema";

// Exact per-item mass-balance residual over the extracted result:
// production - consumption - surplus + deficit - demand + supply, in Fraction
// arithmetic, for every finite-supply item. The extraction recomputes
// surplus/deficit from the final rates, so a hygienic result closes every row
// to exactly zero.
function exactResiduals(
  result: LpResult,
  p: RecipePack,
  targets: Target[],
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
    const supply = effectiveSupply(it.id, p, []);
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
        .sub(surplus)
        .add(deficit)
        .sub(demand.get(it.id) ?? zero)
        .add(supply),
    );
  }
  return residuals;
}

function expectExactlyBalanced(
  result: LpResult,
  p: RecipePack,
  targets: Target[],
): void {
  for (const [itemId, residual] of exactResiduals(result, p, targets)) {
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

    // For each finite-supply item: production - consumption + supply + deficit
    // - surplus must equal demand. Raw items have infinite supply, so skip them.
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
        const residual = bal - surplus + deficit - (demandOf.get(it.id) ?? 0);
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
  });
});
