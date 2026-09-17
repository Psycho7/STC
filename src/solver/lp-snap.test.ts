import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import solver from "javascript-lp-solver";
import { CORPUS } from "./corpus";
import { plainSnap, solveLp, type LpInput, type LpModel } from "./lp";
import { pack } from "../data/load";

// plainSnap computes directly what the extraction used to read through
// fraction.js: new Fraction(v).simplify(min(1e-6, |v| * 1e-6)). The rates every
// pinned suite checks go through it, so it must return the same rational for
// every input, not just a close one.
const SNAP_REL = 1e-6;
const librarySnap = (v: number): Fraction =>
  new Fraction(v).simplify(Math.min(SNAP_REL, Math.abs(v) * SNAP_REL));

// Every primal the engine returns across each pass of a solve: the values the
// extraction snaps (rates, draws, deficits), plus the rest of the raw result.
function primalsOf(input: LpInput): number[] {
  const models: LpModel[] = [];
  solveLp({ ...input, onModel: (_mode, model) => models.push(model) });
  const values: number[] = [];
  for (const model of models) {
    const raw = solver.Solve(model) as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      if (key === "feasible" || key === "bounded" || key === "result") continue;
      if (typeof value === "number" && value > 0) values.push(value);
    }
  }
  return values;
}

function expectSameSnap(values: number[]): void {
  for (const v of values) {
    const expected = librarySnap(v);
    const actual = plainSnap(v);
    expect([actual.s, actual.n, actual.d], String(v)).toEqual([
      expected.s,
      expected.n,
      expected.d,
    ]);
  }
}

describe("plainSnap matches Fraction#simplify", () => {
  it("on rationals with small denominators, exact and perturbed", () => {
    const values: number[] = [];
    for (let d = 1; d <= 400; d += 13) {
      for (let n = 1; n <= 3 * d; n += Math.max(1, Math.floor(d / 4))) {
        for (const e of [0, 1e-13, -1e-11, 3e-9, -2e-7]) {
          values.push((n / d) * (1 + e));
        }
      }
    }
    values.push(1 / 900900, 7 / 900900, 1 / 3, 2 / 7, 5 / 12);
    expectSameSnap(values);
  });

  it("on near-integers", () => {
    const values: number[] = [];
    for (const k of [1, 2, 3, 10, 60, 999, 12345]) {
      for (const e of [1e-12, 1e-9, 5e-7, 2e-6, 1e-4]) {
        values.push(k + e, k - e);
      }
    }
    expectSameSnap(values);
  });

  it("across magnitudes, including sub-snap-radius values", () => {
    const values: number[] = [];
    for (let exp = -12; exp <= 7; exp += 0.37) values.push(1.2345 * 10 ** exp);
    values.push(1e-12, 3e-8, 1e-7, 1.5e-7, 1e-6, 123456.789, 9999999.5);
    expectSameSnap(values);
  });

  it("on negatives", () => {
    const values = [-1 / 3, -2.5, -1e-3, -(1 / 7) * (1 + 1e-10), -42.000001];
    expectSameSnap(values);
  });

  it("throws on zero, like simplify with a zero radius", () => {
    expect(() => librarySnap(0)).toThrow(RangeError);
    expect(() => plainSnap(0)).toThrow(RangeError);
  });

  it("on every positive primal the solver corpus produces", () => {
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
    expectSameSnap(values);
  });

  it("on every positive primal of real-pack plans at unit and small rates", () => {
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
    expectSameSnap(values);
  });
});
