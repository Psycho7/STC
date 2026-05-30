import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp } from "./lp";
import { pack } from "../data/load";
import type { Target } from "../data/targets";
import type { RecipePack } from "@aef/schema";

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

    // For each item with finite supply, production - consumption + supply
    // + deficit - surplus must equal demand. Raw items (Infinity supply) are
    // unconstrained and skipped.
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

describe("solveLp - status and softFeasible", () => {
  it("reports feasible and soft-feasible for the headline plan", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
    ];
    const result = solveLp({ targets, pack });
    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
  });

  it("reports empty status and soft-feasible for no targets", () => {
    const result = solveLp({ targets: [], pack });
    expect(result.status).toBe("empty");
    expect(result.softFeasible).toBe(true);
  });

  it("reports soft-infeasible when an input has no producer", () => {
    // make_prod runs at the pinned rate (positive rate => status "feasible"),
    // but its input "mid" has no producer and is non-raw (finite supply 0), so
    // the LP covers mid via a deficit var. The LP is mathematically feasible
    // through the deficit var; softFeasible is false because that deficit
    // survives the demand-met check.
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
