import { expect, it } from "vitest";
import Fraction from "fraction.js";
import { executionsPerMachine } from "./multiplier";
import { REL_TOL, relSlack } from "./lp";

it("executionsPerMachine is machine speed over recipe time, exactly", () => {
  expect(
    executionsPerMachine({ time: 2 }, { speed: 1 }).equals(new Fraction(1, 2)),
  ).toBe(true);
  expect(
    executionsPerMachine({ time: 0.3 }, { speed: 0.2 }).equals(
      new Fraction(2, 3),
    ),
  ).toBe(true);
});

it("relSlack scales REL_TOL by the largest of the floor and the magnitudes", () => {
  expect(relSlack(0.5)).toBe(0.5 * REL_TOL);
  expect(relSlack(1, 3)).toBe(Math.max(1, 3) * REL_TOL);
  expect(relSlack(1, 0.25, 4, 2)).toBe(Math.max(1, 0.25, 4, 2) * REL_TOL);
  // Magnitudes are taken as given: callers that want |x| pass Math.abs(x).
  expect(relSlack(1, -5)).toBe(REL_TOL);
});
