import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp } from "./lp";
import {
  CLOSED_FORM_FIXTURES,
  CYCLIC_TARGET_FIXTURE,
  V153_RECIPE_IDS,
  withoutV153Recipes,
} from "./closed-form-fixtures";
import { pack } from "../data/load";

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
  it("reports unsatisfiable via a deficit on the demanded item F, not a met target", () => {
    const fx = CYCLIC_TARGET_FIXTURE;
    const r = solveLp({ targets: fx.targets, pack: fx.pack, itemOverrides: [] });
    expect(r.softFeasible).toBe(false);
    expect(r.deficit.has("F")).toBe(true);
  });
});

// The 1.5.3 filter is a pinned id list, so it can silently stop matching the
// shipped pack. Hold it to the exact set it claims to drop.
describe("withoutV153Recipes", () => {
  it("drops exactly the fourteen recipes 1.5.3 added", () => {
    const before = pack.recipes.map((r) => r.id);
    const after = withoutV153Recipes(pack).recipes.map((r) => r.id);
    expect(before.length - after.length).toBe(14);
    const kept = new Set(after);
    const removed = before.filter((id) => !kept.has(id));
    expect(removed.length).toBe(14);
    for (const id of removed) {
      expect(V153_RECIPE_IDS.has(id), `${id} is not a 1.5.3 addition`).toBe(
        true,
      );
    }
    expect(V153_RECIPE_IDS.size).toBe(14);
  });
});
