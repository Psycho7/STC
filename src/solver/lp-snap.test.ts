import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { CORPUS } from "./corpus";
import {
  extractionTuning,
  plainSnap,
  readTableauPrimals,
  solveLp,
  type LpInput,
  type LpModel,
} from "./lp";
import { pack } from "../data/load";

// plainSnap reads a float primal as the exact binary rational it is and returns
// the first continued-fraction convergent within the snap window of it. The
// window is relative below 1 and absolute above: min(1e-7, |v| * 1e-7).
const SNAP_WINDOW = 1e-7;
const windowOf = (v: number): number =>
  Math.min(SNAP_WINDOW, Math.abs(v) * SNAP_WINDOW);

// Every positive unrounded tableau primal across each pass of a solve: the
// values the extraction snaps (rates, draws, deficits), plus the rest.
function primalsOf(input: LpInput): number[] {
  const models: LpModel[] = [];
  solveLp({ ...input, onModel: (_mode, model) => models.push(model) });
  const values: number[] = [];
  for (const model of models) {
    for (const value of readTableauPrimals(model).primals.values()) {
      if (value > 0) values.push(value);
    }
  }
  return values;
}

// The snap never moves a value by more than its window, and keeps its sign.
function expectWithinWindow(values: number[]): void {
  for (const v of values) {
    const snapped = plainSnap(v);
    const moved = Math.abs(snapped.valueOf() - v);
    expect(moved, String(v)).toBeLessThanOrEqual(windowOf(v) * (1 + 1e-9));
    expect(Math.sign(snapped.valueOf()), String(v)).toBe(Math.sign(v));
  }
}

describe("plainSnap", () => {
  it("snaps on the window this suite checks", () => {
    expect(extractionTuning.plainSnapRel).toBe(SNAP_WINDOW);
  });

  it("round-trips p/q exactly on a denominator grid", () => {
    // q stays below sqrt(1e7), see the bound on the next case.
    const denominators = [
      ...Array.from({ length: 60 }, (_, i) => i + 1),
      64,
      90,
      120,
      180,
      360,
      600,
      720,
      900,
      1000,
      1440,
      2520,
      3000,
    ];
    for (const q of denominators) {
      for (const p of [1, 2, 3, 7, q - 1, q + 1, 2 * q + 1, 61 * q + 13]) {
        if (p <= 0) continue;
        for (const sign of [1, -1]) {
          const snapped = plainSnap((sign * p) / q);
          const expected = new Fraction(sign * p, q);
          expect(snapped.equals(expected), `${sign * p}/${q}`).toBe(true);
        }
      }
    }
  });

  // A distinct convergent h/k (k < q) sits at least 1/(k*q) from p/q, so the
  // round trip is guaranteed while p*q < 1e7 below 1 and q*q < 1e7 above it.
  it("round-trips p/q scaled by powers of ten", () => {
    for (const [p, q] of [
      [1, 3],
      [2, 7],
      [5, 12],
    ] as const) {
      for (let exp = -6; exp <= 6; exp++) {
        const expected = new Fraction(p, q).mul(new Fraction(10).pow(exp));
        const snapped = plainSnap(expected.valueOf());
        expect(snapped.equals(expected), `${p}/${q}e${exp}`).toBe(true);
      }
    }
  });

  it("stays within the window on perturbed rationals", () => {
    const values: number[] = [];
    for (let d = 1; d <= 400; d += 13) {
      for (let n = 1; n <= 3 * d; n += Math.max(1, Math.floor(d / 4))) {
        for (const e of [0, 1e-13, -1e-11, 3e-9, -2e-7]) {
          values.push((n / d) * (1 + e));
        }
      }
    }
    values.push(1 / 900900, 7 / 900900, 1 / 404078, 2323 / 60);
    expectWithinWindow(values);
    expectWithinWindow(values.map((v) => -v));
  });

  it("stays within the window on near-integers and across magnitudes", () => {
    const values: number[] = [];
    for (const k of [1, 2, 3, 10, 60, 999, 12345]) {
      for (const e of [1e-12, 1e-9, 5e-7, 2e-6, 1e-4]) {
        values.push(k + e, k - e);
      }
    }
    for (let exp = -12; exp <= 7; exp += 0.37) values.push(1.2345 * 10 ** exp);
    values.push(1e-12, 3e-8, 9.5e-8, 1e-7, 1.5e-7, 1e-6, 123456.789, 9999999.5);
    expectWithinWindow(values);
  });

  it("throws on zero", () => {
    expect(() => plainSnap(0)).toThrow(RangeError);
  });

  it("stays within the window on every positive primal the solver corpus produces", () => {
    const values: number[] = [];
    for (const scenario of CORPUS) {
      values.push(
        ...primalsOf({
          targets: scenario.targets,
          pack: scenario.pack,
          ...(scenario.itemOverrides
            ? { itemOverrides: scenario.itemOverrides }
            : {}),
          ...(scenario.recipeCosts
            ? { recipeCosts: scenario.recipeCosts }
            : {}),
        }),
      );
    }
    expect(values.length).toBeGreaterThan(0);
    expectWithinWindow(values);
  });

  it("stays within the window on every positive primal of real-pack plans at unit and small rates", () => {
    const values: number[] = [];
    for (const denom of ["1", "60"]) {
      values.push(
        ...primalsOf({
          targets: [
            { itemId: "proc_battery_5", ratePerSec: { num: "1", denom } },
          ],
          pack,
        }),
      );
    }
    expect(values.length).toBeGreaterThan(0);
    expectWithinWindow(values);
  });
});
