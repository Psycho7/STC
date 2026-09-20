import { describe, expect, test, beforeAll } from "bun:test";
import {
  akeItemId,
  akeMachineId,
  deriveEnvironments,
  joinAndAssert,
  loadAkeData,
  type AkeJoin,
  type AkeMiner,
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

// Remove one row of one table. Used to prove the join refuses to run with a
// shrunken snapshot instead of quietly skipping the rows it can no longer see.
function drop<T>(table: Record<string, T>, id: string): Record<string, T> {
  if (!table[id]) throw new Error(`test fixture: no row ${id}`);
  const rest = { ...table };
  delete rest[id];
  return rest;
}

function expectThrows(broken: AkeSnapshot, named: string): void {
  expect(() => joinAndAssert(rows, broken)).toThrow(new RegExp(named));
}

// The pack-side counterpart of flip, for the branches a snapshot edit cannot
// reach because the assertion above them fires first.
function packWithMachine(id: string, patch: Partial<Machine>) {
  return {
    ...rows,
    machines: rows.machines.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
}

// The pack-side counterpart of flip, by recipe id. The side-table shape checks
// read the pack row against the table, so a shape only the pack can spell has
// to be broken here.
function packWithRecipe(id: string, patch: Partial<Recipe>) {
  if (!rows.recipes.some((r) => r.id === id)) {
    throw new Error(`test fixture: no recipe ${id}`);
  }
  return {
    ...rows,
    recipes: rows.recipes.map((r) => (r.id === id ? { ...r, ...patch } : r)),
  };
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

  test("an item the snapshot drops fails the join", () => {
    const item = pack.items.find((i) => ake.items[akeItemId(i.id)])!;
    expectThrows(
      { ...ake, items: drop(ake.items, akeItemId(item.id)) },
      item.id,
    );
  });

  test("a machine the snapshot drops fails the join", () => {
    const machine = pack.machines.find(
      (m) => ake.buildings[akeMachineId(m.id)],
    )!;
    expectThrows(
      { ...ake, buildings: drop(ake.buildings, akeMachineId(machine.id)) },
      machine.id,
    );
  });

  test("a craft the snapshot drops fails the join", () => {
    const [recipeId, craftId] = [...join.crafts.entries()][0]!;
    expectThrows({ ...ake, crafts: drop(ake.crafts, craftId) }, recipeId);
  });

  test("an ordinary craft whose ingredients drift fails the join", () => {
    // The stoichiometry is the join key, so a drifted ingredient count does not
    // report a disagreement - it stops the recipe matching at all. Only the
    // unmatched-set assertion catches that.
    const [recipeId, craftId] = [...join.crafts.entries()].find(
      ([, id]) => (ake.crafts[id]!.ingredients[0]?.group.length ?? 0) > 0,
    )!;
    const craft = ake.crafts[craftId]!;
    const [first, ...rest] = craft.ingredients[0]!.group;
    const ingredients = [
      { group: [{ ...first!, count: first!.count + 1 }, ...rest] },
      ...craft.ingredients.slice(1),
    ];
    expectThrows(
      { ...ake, crafts: flip(ake.crafts, craftId, { ingredients }) },
      recipeId,
    );
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
    const item = pack.items.find((i) => i.transportKind === "belt")!;
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

  test("unexpected recommended domain", () => {
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

  test("locations", () => {
    // Both domain values are ones the rule accepts, so the throw comes from the
    // locations comparison rather than the domain check above it.
    const machine = pack.machines.find(
      (m) => m.locations && ake.buildings[akeMachineId(m.id)],
    )!;
    expect(machine.locations).toEqual(["jinlong"]);
    expectThrows(
      {
        ...ake,
        buildings: flip(ake.buildings, akeMachineId(machine.id), {
          recommendDomains: [],
        }),
      },
      machine.id,
    );
  });

  test("burner power draw", () => {
    // A burner's expected draw is null whatever powerConsume says, so only a
    // pack-side value reaches that branch; needPower is left alone so the
    // powerType check above passes.
    const broken = packWithMachine("miner_4", { powerKw: 5 });
    expect(ake.buildings[akeMachineId("miner_4")]!.needPower).toBe(false);
    expect(() => joinAndAssert(broken, ake)).toThrow(/miner_4/);
  });

  test("missing footprint", () => {
    // No carve-out: a joined machine without a size disagrees with the table.
    const broken = {
      ...rows,
      machines: rows.machines.map((m) => {
        if (m.id !== "miner_2") return m;
        const stripped = { ...m };
        delete stripped.size;
        return stripped;
      }),
    };
    expect(() => joinAndAssert(broken, ake)).toThrow(/miner_2/);
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

describe("side tables keep their shape", () => {
  // Every mutation below leaves the recipe matching its table, so the throw has
  // to come from the shape check rather than from the unmatched-set assertion.
  const WATER_MINER = "miner_4";
  const WET_COPPER_RECIPE = "copper_ore-liquid_water";

  // The mineable row a miner or gas miner carries for one pack item, patched in
  // place and the rest of the snapshot left shared.
  function withMineable(
    minerId: string,
    packItemId: string,
    patch: Partial<AkeMiner["mineable"][number]>,
  ): AkeSnapshot {
    const gas = ake.gasMiners[minerId] !== undefined;
    const table = gas ? ake.gasMiners : ake.miners;
    const row = table[minerId];
    if (!row) throw new Error(`test fixture: no miner ${minerId}`);

    const itemId = akeItemId(packItemId);
    const mineable = row.mineable.map((m) =>
      m.miningItemId === itemId ? { ...m, ...patch } : m,
    );
    const flipped = flip(table, minerId, { mineable });
    return gas ? { ...ake, gasMiners: flipped } : { ...ake, miners: flipped };
  }

  test("a miner output quantity the table does not imply fails the join", () => {
    // produceRate is folded into the duration, so the quantity has to stay 1.
    const broken = packWithRecipe("iron_ore", {
      out: [{ item: "iron_ore", qty: 2 }],
    });
    expect(() => joinAndAssert(broken, ake)).toThrow(/iron_ore/);
  });

  test("an input on a free mining recipe fails the join", () => {
    const broken = packWithRecipe("iron_ore", {
      in: [{ item: "liquid_water", qty: 1 }],
    });
    expect(() => joinAndAssert(broken, ake)).toThrow(/iron_ore/);
  });

  test("a mining recipe that drops its consumeItem fails the join", () => {
    const broken = packWithRecipe(WET_COPPER_RECIPE, { in: [] });
    expect(() => joinAndAssert(broken, ake)).toThrow(
      new RegExp(WET_COPPER_RECIPE),
    );
  });

  test("a consumeItem count the pack disagrees with fails the join", () => {
    const row = ake.miners[WATER_MINER]!.mineable.find(
      (m) => m.miningItemId === akeItemId("copper_ore"),
    )!;
    expectThrows(
      withMineable(WATER_MINER, "copper_ore", {
        consumeItem: { ...row.consumeItem, count: row.consumeItem.count + 1 },
      }),
      WET_COPPER_RECIPE,
    );
  });

  test("a gas rate other than one fails the join", () => {
    // The gas table's round is the whole duration, so the pack has nowhere to
    // put a rate; the join refuses rather than dropping it.
    expectThrows(
      withMineable("gas_pump_1", "gas_xiranite", { produceRate: 2 }),
      "gas_xiranite",
    );
  });

  test("an output on a fuel recipe fails the join", () => {
    const broken = packWithRecipe("power_originium_ore", {
      out: [{ item: "originium_ore", qty: 1 }],
    });
    expect(() => joinAndAssert(broken, ake)).toThrow(/power_originium_ore/);
  });

  test("an input on a pump recipe fails the join", () => {
    const broken = packWithRecipe("liquid_water", {
      in: [{ item: "liquid_sewage", qty: 1 }],
    });
    expect(() => joinAndAssert(broken, ake)).toThrow(/liquid_water/);
  });

  test("an output on a fluid-consume recipe fails the join", () => {
    const broken = packWithRecipe("liquid_cleaner_1-sewage", {
      out: [{ item: "liquid_water", qty: 1 }],
    });
    expect(() => joinAndAssert(broken, ake)).toThrow(/liquid_cleaner_1-sewage/);
  });
});

describe("environment derivation", () => {
  // The one acidic craft today; the atmosphere it demands is read off its
  // gasEnv, so breaking that row is what the two throw paths below do.
  const ACIDIC_RECIPE = "gas_copper_enr2";

  function acidicCraftId(): string {
    const craftId = join.crafts.get(ACIDIC_RECIPE);
    if (!craftId)
      throw new Error(`test fixture: ${ACIDIC_RECIPE} did not join`);
    return craftId;
  }

  // One recipe of each join shape, both stamped with no atmosphere today: the
  // flip tests below give them one and expect it to reach the pack recipe.
  const SINGLE_PRODUCER_RECIPE = "plant_moss_powder_1";
  const MIX_POOL_RECIPE = "copper_enr";
  const STABLE_GAS_ENV = 1;

  function mixPoolCraftIds(): string[] {
    const craftIds = join.producerCrafts.get(MIX_POOL_RECIPE);
    if (!craftIds)
      throw new Error(`test fixture: ${MIX_POOL_RECIPE} is not multi-producer`);
    return craftIds;
  }

  test("an atmosphere on a single-producer craft reaches its recipe", () => {
    const craftId = join.crafts.get(SINGLE_PRODUCER_RECIPE);
    if (!craftId)
      throw new Error(`test fixture: ${SINGLE_PRODUCER_RECIPE} did not join`);

    const flipped = {
      ...ake,
      crafts: flip(ake.crafts, craftId, { gasEnv: STABLE_GAS_ENV }),
    };
    expect(deriveEnvironments(flipped, join).get(SINGLE_PRODUCER_RECIPE)).toBe(
      "stable",
    );
  });

  test("an atmosphere on every craft of a mix-pool recipe reaches its recipe", () => {
    let crafts = ake.crafts;
    for (const craftId of mixPoolCraftIds()) {
      crafts = flip(crafts, craftId, { gasEnv: STABLE_GAS_ENV });
    }

    expect(
      deriveEnvironments({ ...ake, crafts }, join).get(MIX_POOL_RECIPE),
    ).toBe("stable");
  });

  test("mix-pool crafts that disagree on the atmosphere fail the derivation", () => {
    const craftIds = mixPoolCraftIds();
    const broken = {
      ...ake,
      crafts: flip(ake.crafts, craftIds[0]!, { gasEnv: STABLE_GAS_ENV }),
    };

    // The crafts are named in table order, which is not the join's order.
    let message = "";
    try {
      deriveEnvironments(broken, join);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(MIX_POOL_RECIPE);
    for (const craftId of craftIds) expect(message).toContain(craftId);
  });

  test("an unrecognised gasEnv value fails the derivation", () => {
    const craftId = acidicCraftId();
    const broken = { ...ake, crafts: flip(ake.crafts, craftId, { gasEnv: 2 }) };
    expect(() => deriveEnvironments(broken, join)).toThrow(new RegExp(craftId));
  });

  test("an atmosphere craft with no pack recipe fails the derivation", () => {
    const craftId = acidicCraftId();
    const recipes = rows.recipes.filter((r) => r.id !== ACIDIC_RECIPE);
    const partial = joinAndAssert({ ...rows, recipes }, ake);
    expect(() => deriveEnvironments(ake, partial)).toThrow(new RegExp(craftId));
  });
});

function electricMachine(): Machine {
  return pack.machines.find(
    (m) => m.powerType === "electric" && ake.buildings[akeMachineId(m.id)],
  )!;
}
