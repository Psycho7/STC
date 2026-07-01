import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp } from "./lp";
import { makePack } from "./closed-form-fixtures";
import { pack } from "../data/load";
import { isExcludedProducer } from "../data/recipe-category";
import type { Target } from "../data/targets";

// Deficit-dominated plus tight cost-cap stress case.
// Satisfiable part: a: M -> F; M comes from b1 (R) and b2 (S), both raw, so the
// 2-unit M demand splits with alternate optima, resolved by the pass-2 lex
// tie-break (lower recipe id wins: b1 over b2). Unsourceable part: bad: X -> G
// where X has no producer, so a 1e9-weight deficit dominates pass 1.
// Does that deficit corrupt the chain solution or swamp the lex tie-break?
// Uncorrupted answer: x_a=2, x_b1=2, x_b2=0, deficit on X.
const stressPack = makePack(
  [
    { id: "a", time: 1, in: { M: 1 }, out: { F: 1 } },
    { id: "b1", time: 1, in: { R: 1 }, out: { M: 1 } },
    { id: "b2", time: 1, in: { S: 1 }, out: { M: 1 } },
    { id: "bad", time: 1, in: { X: 1 }, out: { G: 1 } },
  ],
  [
    { id: "F", stack: 1 }, { id: "G", stack: 1 }, { id: "M", stack: 1 },
    { id: "R", raw: true, stack: 1 }, { id: "S", raw: true, stack: 1 },
    { id: "X", stack: 1 },
  ],
);
const stressTargets: Target[] = [
  { recipeId: "a", ratePerSec: { num: "2", denom: "1" } },
  { recipeId: "bad", ratePerSec: { num: "1", denom: "1" } },
];

describe("big-M numerical conditioning", () => {
  it("deficit domination does not corrupt the satisfiable sub-solution or the lex tie-break", () => {
    const r = solveLp({ targets: stressTargets, pack: stressPack, itemOverrides: [] });

    // Honest infeasibility for the unsourceable target.
    expect(r.softFeasible).toBe(false);
    expect(r.deficit.has("X")).toBe(true);

    // Satisfiable chain stays exact under the 1e9-dominated objective.
    expect(r.rates.get("a")!.equals(new Fraction(2))).toBe(true);

    // Lex tie-break stays deterministic (b1 over b2) despite the swamped cost-cap.
    expect(r.rates.get("b1")!.equals(new Fraction(2))).toBe(true);
    expect((r.rates.get("b2") ?? new Fraction(0)).equals(new Fraction(0))).toBe(true);
  });
});

// Pass-2 lex leak at extreme target scales. The lex pass's cost_cap row grows
// with target scale, and the solver's internal relative feasibility tolerance
// (~3e-9 of the row total) at costCap >= ~1e9 buys big-M (cost 1e6) recipes
// enough rate to clear extraction. No big-M (target-only / excluded-producer)
// recipe is pinned here, so none may appear in the rates map at any scale.
describe("big-M pass-2 lex leak at extreme scales", () => {
  const bigMIds = new Set(
    pack.recipes
      .filter((r) => r.flags?.includes("target-only") || isExcludedProducer(r))
      .map((r) => r.id),
  );

  for (const scale of ["100000000", "1000000000"]) {
    it(`glass_enr_bottle at ${scale}/s admits no big-M recipe`, () => {
      const targets: Target[] = [
        { recipeId: "glass_enr_bottle", ratePerSec: { num: scale, denom: "1" } },
      ];
      const r = solveLp({ targets, pack, itemOverrides: [] });
      const leaked = [...r.rates.keys()].filter((id) => bigMIds.has(id));
      expect(leaked).toEqual([]);
    });
  }
});
