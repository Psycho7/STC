import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp } from "./lp";
import {
  CLOSED_FORM_FIXTURES,
  CYCLIC_TARGET_FIXTURE,
} from "./closed-form-fixtures";

describe("closed-form fixtures - solveLp matches hand-derived truth", () => {
  for (const fx of CLOSED_FORM_FIXTURES) {
    it(`${fx.name}: matches closed-form expected`, () => {
      const r = solveLp({
        targets: fx.targets,
        pack: fx.pack,
        itemOverrides: fx.itemOverrides ?? [],
      });

      expect(r.softFeasible).toBe(fx.expected.softFeasible);

      for (const item of fx.expected.deficitItems ?? []) {
        expect(r.deficit.has(item), `expected deficit on ${item}`).toBe(true);
      }
      if (fx.expected.softFeasible) {
        expect(r.deficit.size, "no deficits when softFeasible").toBe(0);
      }

      for (const s of fx.expected.surplus ?? []) {
        const got = r.surplus.get(s.itemId);
        expect(got, `expected surplus on ${s.itemId}`).toBeDefined();
        expect(got!.equals(new Fraction(s.num, s.den))).toBe(true);
      }

      for (const rate of fx.expected.rates ?? []) {
        const got = r.rates.get(rate.recipeId);
        expect(got, `expected rate for ${rate.recipeId}`).toBeDefined();
        expect(got!.equals(new Fraction(rate.num, rate.den))).toBe(true);
      }
    });
  }
});

// Lock the cyclic-target honest-infeasibility contract.
describe("cyclic-target contract (STC-0005)", () => {
  it("reports unsatisfiable via a deficit on M, not a met target", () => {
    const fx = CYCLIC_TARGET_FIXTURE;
    const r = solveLp({ targets: fx.targets, pack: fx.pack, itemOverrides: [] });
    expect(r.softFeasible).toBe(false);
    expect(r.deficit.has("M")).toBe(true);
  });
});
