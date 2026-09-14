import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Machine, Recipe, Stoich } from "@aef/schema";
import { catalystChargeOf } from "./catalyst";

const PER_MINUTE = 60;

// The two pack encodings of the same 6/min charge: 0.2 per 2 s cycle on the
// solid-gas transmuters, 1 per 10 s cycle on the enriched liquid-gas ones.
const encodings = [
  { label: "qty 0.2 on a 2 s cycle", qty: 0.2, time: 2 },
  { label: "qty 1 on a 10 s cycle", qty: 1, time: 10 },
];

function stoich(qty: number): Stoich {
  return { item: "gas_xiranite", qty };
}

function recipeWithTime(time: number): Pick<Recipe, "time"> {
  return { time };
}

function machineWithSpeed(speed: number): Pick<Machine, "speed"> {
  return { speed };
}

describe("catalystChargeOf", () => {
  for (const enc of encodings) {
    describe(enc.label, () => {
      const cases: ReadonlyArray<{
        machines: Fraction;
        perMinute: number;
        perSecond: Fraction;
      }> = [
        {
          machines: new Fraction(2, 5),
          perMinute: 6,
          perSecond: new Fraction(1, 10),
        },
        {
          machines: new Fraction(1),
          perMinute: 6,
          perSecond: new Fraction(1, 10),
        },
        {
          machines: new Fraction(101, 100),
          perMinute: 12,
          perSecond: new Fraction(1, 5),
        },
        {
          machines: new Fraction(4),
          perMinute: 24,
          perSecond: new Fraction(2, 5),
        },
      ];

      for (const c of cases) {
        it(`${c.machines.toFraction()} machines charge ${c.perMinute}/min`, () => {
          const charge = catalystChargeOf(
            c.machines,
            stoich(enc.qty),
            recipeWithTime(enc.time),
            machineWithSpeed(1),
          );
          expect(charge.equals(c.perSecond)).toBe(true);
          expect(charge.mul(PER_MINUTE).equals(new Fraction(c.perMinute))).toBe(
            true,
          );
        });
      }
    });
  }

  it("keeps qty 0.2 exact rather than a float approximation", () => {
    const charge = catalystChargeOf(
      new Fraction(1),
      stoich(0.2),
      recipeWithTime(1),
      machineWithSpeed(1),
    );
    expect(charge.toFraction()).toBe("1/5");
  });

  it("scales with machine speed", () => {
    const charge = catalystChargeOf(
      new Fraction(1),
      stoich(0.2),
      recipeWithTime(2),
      machineWithSpeed(2),
    );
    expect(charge.equals(new Fraction(1, 5))).toBe(true);
  });

  it("charges nothing for zero machines", () => {
    const charge = catalystChargeOf(
      new Fraction(0),
      stoich(0.2),
      recipeWithTime(2),
      machineWithSpeed(1),
    );
    expect(charge.equals(0)).toBe(true);
  });
});
