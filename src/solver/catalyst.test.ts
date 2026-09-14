import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Machine, Recipe, Stoich } from "@aef/schema";
import { catalystChargeOf } from "./catalyst";
import { solvePlanWithIntermediates } from "./index";
import { solveLp } from "./lp";
import { netSelfConsumption } from "./net-self";
import { pack } from "../data/load";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";

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

// ---------------------------------------------------------------------------
// buildCatalystAccount, driven end to end on the shipped pack.
//
// Two plans, one per catalyst item, each asking for 1/min of an enriched
// product so every transmuter in them runs at a small fraction of a machine.
// A fraction of a machine still holds a whole machine's charge, so the need is
// the flat 6/min = 1/10 per second in every row below, orders of magnitude
// above the per-cycle rate * qty the old continuous model reported. That
// makes these plans the sharp test of the per-machine rule as well as of the
// pool split.
// ---------------------------------------------------------------------------

// gas_xiranite is raw; the enriched-gas plan cycles it on
// phase_trans_2-xiranite_powder.
const GAS_ITEM = "gas_xiranite";
const GAS_TARGETS: ItemTarget[] = [
  { itemId: "gas_xiranite_enr", ratePerSec: { num: "1", denom: "60" } },
];
// liquid_xiranite is NOT raw, so its default supply is 0 with no typed cap -
// the row ruling 6 keeps unlimited for the catalyst.
const LIQUID_ITEM = "liquid_xiranite";
const LIQUID_TARGETS: ItemTarget[] = [
  { itemId: "liquid_xiranite_enr", ratePerSec: { num: "1", denom: "60" } },
];

// 6/min, the charge one transmuter holds under both pack encodings.
const NEED = new Fraction(1, 10);

const capped = (itemId: string, num: string, denom: string): ItemOverride => ({
  itemId,
  ratePerSec: { num, denom },
});
const catalystRow = (
  itemId: string,
  rate?: [num: string, denom: string],
): ItemOverride => ({
  itemId,
  role: "catalyst",
  ...(rate !== undefined
    ? { ratePerSec: { num: rate[0], denom: rate[1] } }
    : {}),
});

type AccountCase = {
  label: string;
  item: string;
  targets: ItemTarget[];
  overrides: ItemOverride[];
  fromCatalyst: [num: number, den: number];
  fromGeneral: [num: number, den: number];
  unmet: [num: number, den: number];
};

// Every row of the headroom table, with and without a C row, on both items.
// The C row is capped at 1/20 (half the need) wherever the point is what G
// does with the remainder.
const ACCOUNT_CASES: AccountCase[] = [
  {
    label: "raw with no override is free: G covers the whole charge",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [],
    fromCatalyst: [0, 1],
    fromGeneral: [1, 10],
    unmet: [0, 1],
  },
  {
    label: "raw and free, uncapped C row: C covers it and G is untouched",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [catalystRow(GAS_ITEM)],
    fromCatalyst: [1, 10],
    fromGeneral: [0, 1],
    unmet: [0, 1],
  },
  {
    label: "raw and free, C above the need: nothing is billed to G",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [catalystRow(GAS_ITEM, ["1", "5"])],
    fromCatalyst: [1, 10],
    fromGeneral: [0, 1],
    unmet: [0, 1],
  },
  {
    label: "field-less override is free, C short: G takes the remainder",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [{ itemId: GAS_ITEM }, catalystRow(GAS_ITEM, ["1", "20"])],
    fromCatalyst: [1, 20],
    fromGeneral: [1, 20],
    unmet: [0, 1],
  },
  {
    label: "typed cap above 0, no C row: G gives what the draw left",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    // The LP draws 1/24 of this 1/10 cap for ordinary consumption (pinned
    // below), so the catalyst sees 1/10 - 1/24 = 7/120 and comes up 1/24 short.
    overrides: [capped(GAS_ITEM, "1", "10")],
    fromCatalyst: [0, 1],
    fromGeneral: [7, 120],
    unmet: [1, 24],
  },
  {
    label: "typed cap above 0, C short: the remainder fits the headroom",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [
      capped(GAS_ITEM, "1", "10"),
      catalystRow(GAS_ITEM, ["1", "20"]),
    ],
    fromCatalyst: [1, 20],
    fromGeneral: [1, 20],
    unmet: [0, 1],
  },
  {
    label: "typed cap of 0, no C row: the whole charge is unmet",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [capped(GAS_ITEM, "0", "1")],
    fromCatalyst: [0, 1],
    fromGeneral: [0, 1],
    unmet: [1, 10],
  },
  {
    label: "typed cap of 0, C short: the remainder is unmet",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [capped(GAS_ITEM, "0", "1"), catalystRow(GAS_ITEM, ["1", "20"])],
    fromCatalyst: [1, 20],
    fromGeneral: [0, 1],
    unmet: [1, 20],
  },
  {
    label: "plan:true raw, no C row: nobody typed a limit, so G is unlimited",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [{ itemId: GAS_ITEM, plan: true }],
    fromCatalyst: [0, 1],
    fromGeneral: [1, 10],
    unmet: [0, 1],
  },
  {
    label: "plan:true raw, C short: G is spent, so the remainder is unmet",
    item: GAS_ITEM,
    targets: GAS_TARGETS,
    overrides: [
      { itemId: GAS_ITEM, plan: true },
      catalystRow(GAS_ITEM, ["1", "20"]),
    ],
    fromCatalyst: [1, 20],
    fromGeneral: [0, 1],
    unmet: [1, 20],
  },
  {
    label: "non-raw default, no C row: G is unlimited, nothing is unmet",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [],
    fromCatalyst: [0, 1],
    fromGeneral: [1, 10],
    unmet: [0, 1],
  },
  {
    label: "non-raw default, C short: G is spent, so the remainder is unmet",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [catalystRow(LIQUID_ITEM, ["1", "20"])],
    fromCatalyst: [1, 20],
    fromGeneral: [0, 1],
    unmet: [1, 20],
  },
  {
    label: "non-raw field-less override is free: G covers the whole charge",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [{ itemId: LIQUID_ITEM }],
    fromCatalyst: [0, 1],
    fromGeneral: [1, 10],
    unmet: [0, 1],
  },
  {
    label: "non-raw plan:true is free, C short: G takes the remainder",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [
      { itemId: LIQUID_ITEM, plan: true },
      catalystRow(LIQUID_ITEM, ["1", "20"]),
    ],
    fromCatalyst: [1, 20],
    fromGeneral: [1, 20],
    unmet: [0, 1],
  },
  {
    label:
      "non-raw typed cap above 0, no C row: no ordinary draw, full headroom",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    // Nothing consumes liquid_xiranite here, so the LP draws none of the cap
    // and the catalyst gets all 1/20 of it - half the need.
    overrides: [capped(LIQUID_ITEM, "1", "20")],
    fromCatalyst: [0, 1],
    fromGeneral: [1, 20],
    unmet: [1, 20],
  },
  {
    label: "non-raw typed cap above 0, C short: both pools pay half",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [
      capped(LIQUID_ITEM, "1", "20"),
      catalystRow(LIQUID_ITEM, ["1", "20"]),
    ],
    fromCatalyst: [1, 20],
    fromGeneral: [1, 20],
    unmet: [0, 1],
  },
  {
    label: "non-raw typed cap of 0, no C row: the whole charge is unmet",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [capped(LIQUID_ITEM, "0", "1")],
    fromCatalyst: [0, 1],
    fromGeneral: [0, 1],
    unmet: [1, 10],
  },
  {
    label: "non-raw typed cap of 0, C short: the remainder is unmet",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [
      capped(LIQUID_ITEM, "0", "1"),
      catalystRow(LIQUID_ITEM, ["1", "20"]),
    ],
    fromCatalyst: [1, 20],
    fromGeneral: [0, 1],
    unmet: [1, 20],
  },
  {
    label: "non-raw, C above the need: nothing is billed to G",
    item: LIQUID_ITEM,
    targets: LIQUID_TARGETS,
    overrides: [catalystRow(LIQUID_ITEM, ["1", "5"])],
    fromCatalyst: [1, 10],
    fromGeneral: [0, 1],
    unmet: [0, 1],
  },
];

describe("catalystAccount on the shipped pack", () => {
  it.each(ACCOUNT_CASES)("$label", (c) => {
    const full = solvePlanWithIntermediates(c.targets, pack, c.overrides);
    const entry = full.catalystAccount.get(c.item)!;
    expect(entry, `no account entry for ${c.item}`).toBeDefined();
    expect({
      need: entry.need.toFraction(),
      fromCatalyst: entry.fromCatalyst.toFraction(),
      fromGeneral: entry.fromGeneral.toFraction(),
      unmet: entry.unmet.toFraction(),
    }).toEqual({
      need: NEED.toFraction(),
      fromCatalyst: new Fraction(...c.fromCatalyst).toFraction(),
      fromGeneral: new Fraction(...c.fromGeneral).toFraction(),
      unmet: new Fraction(...c.unmet).toFraction(),
    });
    // An unmet catalyst is a report, never a solver state: the plan is still
    // delivered at its full target.
    expect(full.feasibility.softFeasible).toBe(true);
  });

  it("charges a whole machine for a plan that runs a fraction of one", () => {
    const full = solvePlanWithIntermediates(GAS_TARGETS, pack, []);
    // phase_trans_2-xiranite_powder cycles 0.2 gas_xiranite per 2 s cycle and
    // runs at 1/120 cycles/s here, which is 1/60 of a machine.
    const rate = full.rates.get("phase_trans_2-xiranite_powder")!;
    expect(rate.equals(new Fraction(1, 120))).toBe(true);
    const charging = [...full.replicas].filter(
      (r) => r.recipeId === "phase_trans_2-xiranite_powder",
    );
    expect(charging).toHaveLength(1);
    expect(
      full.idealCount.get(charging[0]!.id)!.equals(new Fraction(1, 60)),
    ).toBe(true);
    // The old continuous reading was rate * qty = 1/600 per second. The whole
    // machine the transmuter occupies holds sixty times that.
    expect(full.catalystAccount.get(GAS_ITEM)!.need.equals(NEED)).toBe(true);
    expect(NEED.equals(rate.mul(new Fraction(0.2)).mul(60))).toBe(true);
  });

  it("reads the ordinary draw off the LP when sizing G's headroom", () => {
    const overrides = [capped(GAS_ITEM, "1", "10")];
    const result = solveLp({
      targets: GAS_TARGETS,
      pack: netSelfConsumption(pack),
      itemOverrides: overrides,
    });
    expect(result.draws.get(GAS_ITEM)!.equals(new Fraction(1, 24))).toBe(true);
    const full = solvePlanWithIntermediates(GAS_TARGETS, pack, overrides);
    const entry = full.catalystAccount.get(GAS_ITEM)!;
    // 1/10 - 1/24 = 7/120, and the need overshoots it by 1/24.
    expect(
      entry.fromGeneral.equals(new Fraction(1, 10).sub(new Fraction(1, 24))),
    ).toBe(true);
    expect(entry.unmet.equals(NEED.sub(entry.fromGeneral))).toBe(true);
  });

  it("omits an item the plan cycles none of", () => {
    const full = solvePlanWithIntermediates(GAS_TARGETS, pack, []);
    expect(full.catalystAccount.has(LIQUID_ITEM)).toBe(false);
  });
});
