import { describe, expect, test, beforeAll } from "bun:test";
import {
  akeItemId,
  akeMachineId,
  joinAndAssert,
  loadAkeData,
  type AkeJoin,
  type AkeSnapshot,
} from "./akedata.ts";
import { WORLD_NODE_MACHINES, main as runExtractor } from "./extract.ts";
import type { Item, Machine, Recipe, RecipePack } from "./schema.ts";

let pack: RecipePack;
let ake: AkeSnapshot;
let join: AkeJoin;
let rows: { items: Item[]; machines: Machine[]; recipes: Recipe[] };

beforeAll(async () => {
  ({ pack } = await runExtractor({ write: false }));
  ake = await loadAkeData();
  rows = { items: pack.items, machines: pack.machines, recipes: pack.recipes };
  join = joinAndAssert(rows, ake);
});

// Replace one row of one table, leaving every other row shared. The flip tests
// below each break exactly one derivable field this way and expect the join to
// name the row it broke.
function flip<T>(
  table: Record<string, T>,
  id: string,
  patch: Partial<T>,
): Record<string, T> {
  const row = table[id];
  if (!row) throw new Error(`test fixture: no row ${id}`);
  return { ...table, [id]: { ...row, ...patch } };
}

function expectThrows(broken: AkeSnapshot, named: string): void {
  expect(() => joinAndAssert(rows, broken)).toThrow(new RegExp(named));
}

// The unmatched families, named by their producers: no game table carries a
// coupon exchange, a purification gate or a hub transfer.
function unmatchedFamily(r: Recipe): string | undefined {
  if (r.producers.some((p) => p.startsWith("settlement-"))) return "coupon";
  if (r.producers.includes("__domain_transfer")) return "domain-transfer";
  if (r.producers.some((p) => WORLD_NODE_MACHINES.includes(p))) return "gate";
  return undefined;
}

describe("join shape", () => {
  test("142 craft matches in pass 1, none ambiguous", () => {
    expect(join.crafts.size).toBe(142);
    expect(join.ambiguous).toEqual([]);
  });

  test("25 recipes resolve from the multi-producer and side tables", () => {
    expect(join.sideTable.size).toBe(25);
    const byTable: Record<string, number> = {};
    for (const table of join.sideTable.values()) {
      byTable[table] = (byTable[table] ?? 0) + 1;
    }
    expect(byTable).toEqual({
      FactoryMachineCraftTable: 8,
      FactoryMinerTable: 4,
      FactoryGasMinerTable: 2,
      FactoryFluidPumpInTable: 2,
      FactoryFluidConsumeTable: 3,
      FactoryFuelItemTable: 6,
    });
  });

  test("the unmatched recipes are exactly the transfer, coupon and gate rows", () => {
    const expected = pack.recipes.filter(
      (r) => unmatchedFamily(r) !== undefined,
    );
    const byFamily: Record<string, number> = {};
    for (const r of expected) {
      const family = unmatchedFamily(r)!;
      byFamily[family] = (byFamily[family] ?? 0) + 1;
    }
    expect(byFamily).toEqual({
      "domain-transfer": 59,
      coupon: 28,
      gate: 2,
    });
    expect(expected).toHaveLength(89);
    expect([...join.unmatchedRecipes].sort()).toEqual(
      expected.map((r) => r.id).sort(),
    );
  });

  test("every recipe lands in exactly one bucket", () => {
    expect(
      join.crafts.size + join.sideTable.size + join.unmatchedRecipes.length,
    ).toBe(pack.recipes.length);
  });

  test("only the coupon and key items fail to join", () => {
    expect([...join.unmatchedItems].sort()).toEqual([
      "domain_key_tundra",
      "jinlong_coupon",
      "tundra_coupon",
    ]);
  });

  test("only the transfer, gate and settlement machines fail to join", () => {
    expect([...join.unmatchedMachines].sort()).toEqual([
      "__domain_transfer",
      "liquid_clean_gate",
      "liquid_recycle_gate",
      "settlement-jinlong",
      "settlement-jinlong_coupon",
      "settlement-tundra",
      "settlement-tundra_coupon",
    ]);
  });

  test("all 24 catalyst recipes match in pass 1", () => {
    // The extractor lifts the transmuter charge off `in` before the join runs,
    // which is the shape the craft table already has, so the catalyst rows need
    // no pass of their own.
    const catalyst = pack.recipes.filter((r) => r.catalyst);
    expect(catalyst).toHaveLength(24);
    for (const producer of ["phase_trans_1", "phase_trans_2"]) {
      expect(
        catalyst.filter((r) => r.producers.includes(producer)),
      ).toHaveLength(12);
    }
    for (const r of catalyst) {
      expect(join.crafts.has(r.id)).toBe(true);
    }
  });
});

describe("derivable fields disagree loudly", () => {
  test("craft time", () => {
    const [recipeId, craftId] = [...join.crafts.entries()][0]!;
    const craft = ake.crafts[craftId]!;
    expectThrows(
      {
        ...ake,
        crafts: flip(ake.crafts, craftId, {
          progressRound: craft.progressRound + 1,
        }),
      },
      recipeId,
    );
  });

  test("miner time", () => {
    expectThrows(
      { ...ake, miners: flip(ake.miners, "miner_2", { msPerRound: 4000 }) },
      "originium_ore",
    );
  });

  test("power-station fuel time", () => {
    expectThrows(
      {
        ...ake,
        fuelItems: flip(ake.fuelItems, "item_originium_ore", {
          progressRound: 9,
        }),
      },
      "power_originium_ore",
    );
  });

  test("power-generation usage", () => {
    expectThrows(
      {
        ...ake,
        fuelItems: flip(ake.fuelItems, "item_originium_ore", {
          powerProvide: 51,
        }),
      },
      "power_originium_ore",
    );
  });

  test("stack size", () => {
    const item = pack.items.find((i) => i.stack !== undefined)!;
    expectThrows(
      {
        ...ake,
        items: flip(ake.items, akeItemId(item.id), {
          maxBackpackStackCount: 7,
        }),
      },
      item.id,
    );
  });

  test("transport phase", () => {
    const item = pack.items.find(
      (i) => i.transportKind === "belt" && i.id !== "activity_copper_poly_gas",
    )!;
    expectThrows(
      {
        ...ake,
        factoryItems: flip(ake.factoryItems, akeItemId(item.id), {
          phaseType: 2,
        }),
      },
      item.id,
    );
  });

  test("unknown transport phase", () => {
    const item = pack.items.find((i) => i.transportKind === "belt")!;
    expectThrows(
      {
        ...ake,
        factoryItems: flip(ake.factoryItems, akeItemId(item.id), {
          phaseType: 9,
        }),
      },
      item.id,
    );
  });

  test("power draw", () => {
    const machine = electricMachine();
    const row = ake.buildings[akeMachineId(machine.id)]!;
    expectThrows(
      {
        ...ake,
        buildings: flip(ake.buildings, akeMachineId(machine.id), {
          powerConsume: row.powerConsume + 1,
        }),
      },
      machine.id,
    );
  });

  test("power type", () => {
    const machine = electricMachine();
    expectThrows(
      {
        ...ake,
        buildings: flip(ake.buildings, akeMachineId(machine.id), {
          needPower: false,
        }),
      },
      machine.id,
    );
  });

  test("locations", () => {
    const machine = pack.machines.find((m) => m.locations)!;
    expectThrows(
      {
        ...ake,
        buildings: flip(ake.buildings, akeMachineId(machine.id), {
          recommendDomains: ["domain_1"],
        }),
      },
      machine.id,
    );
  });

  test("footprint", () => {
    const machine = pack.machines.find(
      (m) => m.size && ake.buildings[akeMachineId(m.id)],
    )!;
    const row = ake.buildings[akeMachineId(machine.id)]!;
    expectThrows(
      {
        ...ake,
        buildings: flip(ake.buildings, akeMachineId(machine.id), {
          range: { ...row.range, width: row.range.width + 1 },
        }),
      },
      machine.id,
    );
  });

  test("domain-transfer hub value", () => {
    const transfer = pack.recipes.find((r) =>
      r.producers.includes("__domain_transfer"),
    )!;
    const itemId = akeItemId(transfer.out[0]!.item);
    expectThrows(
      {
        ...ake,
        factoryItems: flip(ake.factoryItems, itemId, {
          value: ake.factoryItems[itemId]!.value + 1,
        }),
      },
      transfer.id,
    );
  });

  test("domain-transfer member set", () => {
    const transfer = pack.recipes.find((r) =>
      r.producers.includes("__domain_transfer"),
    )!;
    const packItemId = transfer.out[0]!.item;
    expectThrows(
      {
        ...ake,
        factoryItems: flip(ake.factoryItems, akeItemId(packItemId), {
          showInHubDomainIds: [],
        }),
      },
      packItemId,
    );
  });
});

describe("known vendor disagreement", () => {
  test("activity_copper_poly_gas is exempt from the transport-phase rule", () => {
    // The game table calls it a gas, endfield-calc calls it a belt item because
    // it carries a stack size. The table is right; correcting the pack is its
    // own change, and it removes this exemption.
    const item = pack.items.find((i) => i.id === "activity_copper_poly_gas")!;
    expect(item.transportKind).toBe("belt");
    expect(ake.factoryItems[akeItemId(item.id)]!.phaseType).toBe(4);
  });
});

function electricMachine(): Machine {
  return pack.machines.find(
    (m) => m.powerType === "electric" && ake.buildings[akeMachineId(m.id)],
  )!;
}
