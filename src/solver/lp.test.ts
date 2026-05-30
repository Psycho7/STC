import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp } from "./lp";
import { pack } from "../data/load";
import type { Target } from "../data/targets";

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
