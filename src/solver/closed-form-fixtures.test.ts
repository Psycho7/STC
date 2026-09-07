import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { catalystDrawFromRates, solveLp } from "./lp";
import { solvePlanWithIntermediates } from "./index";
import { defaultTransportConfig } from "../data/transport-config";
import {
  CATALYST_FIXTURES,
  CLOSED_FORM_FIXTURES,
  CYCLIC_TARGET_FIXTURE,
} from "./closed-form-fixtures";
import type { ClosedFormFixture } from "./closed-form-fixtures";

function checkFixture(fx: ClosedFormFixture): void {
  const r = solveLp({
    targets: fx.targets,
    pack: fx.pack,
    itemOverrides: fx.itemOverrides ?? [],
  });

  expect(r.softFeasible).toBe(fx.expected.softFeasible);

  for (const item of fx.expected.deficitItems ?? []) {
    expect(r.deficit.has(item), `expected deficit on ${item}`).toBe(true);
  }
  // Shortfall magnitudes are pinned exhaustively when declared.
  const shortfalls = fx.expected.deficits;
  if (shortfalls !== undefined) {
    expect([...r.deficit.keys()].sort()).toEqual(
      shortfalls.map((d) => d.itemId).sort(),
    );
    for (const d of shortfalls) {
      expect(r.deficit.get(d.itemId)!.equals(new Fraction(d.num, d.den))).toBe(
        true,
      );
    }
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

  // Draw and catalyst-draw maps are pinned exhaustively when declared: an
  // extra entry is as wrong as a missing one, and zeros are never reported.
  const drawn = fx.expected.draws;
  if (drawn !== undefined) {
    expect([...r.draws.keys()].sort()).toEqual(
      drawn.map((d) => d.itemId).sort(),
    );
    for (const d of drawn) {
      expect(r.draws.get(d.itemId)!.equals(new Fraction(d.num, d.den))).toBe(
        true,
      );
    }
  }
  const cat = fx.expected.catalystDraw;
  if (cat !== undefined) {
    const got = catalystDrawFromRates(fx.pack.recipes, r.rates);
    expect([...got.keys()].sort()).toEqual(cat.map((c) => c.itemId).sort());
    for (const c of cat) {
      expect(got.get(c.itemId)!.equals(new Fraction(c.num, c.den))).toBe(true);
    }
  }
}

describe("closed-form fixtures - solveLp matches hand-derived truth", () => {
  for (const fx of CLOSED_FORM_FIXTURES) {
    it(`${fx.name}: matches closed-form expected`, () => {
      checkFixture(fx);
    });
  }
});

// A catalyst is cycled, not consumed: it stays out of mass balance but is drawn
// from the boundary and shares the item's supply cap. These four fixtures pin
// the cap arithmetic on each side of that rule.
describe("closed-form fixtures - catalysts", () => {
  for (const fx of CATALYST_FIXTURES) {
    it(`${fx.name}: matches closed-form expected`, () => {
      checkFixture(fx);
    });
  }

  // solveLp alone never runs the reference-free checkers. Take the same four
  // through the pipeline entry that does (assertInvariants fires under DEV),
  // so "no invariant assertion fires on a cycled catalyst" is asserted rather
  // than assumed, and read catalystDraw off the assembled plan instead of
  // recomputing it.
  for (const fx of CATALYST_FIXTURES) {
    it(`${fx.name}: passes the solve-pipeline invariants`, () => {
      const full = solvePlanWithIntermediates(
        fx.targets,
        fx.pack,
        defaultTransportConfig,
        fx.itemOverrides ?? [],
      );
      const cat = fx.expected.catalystDraw!;
      expect([...full.catalystDraw.keys()].sort()).toEqual(
        cat.map((c) => c.itemId).sort(),
      );
      for (const c of cat) {
        expect(
          full.catalystDraw.get(c.itemId)!.equals(new Fraction(c.num, c.den)),
        ).toBe(true);
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
