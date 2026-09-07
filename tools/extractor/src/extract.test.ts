import { describe, expect, test, beforeAll } from "bun:test";
import { resolve } from "node:path";
import Fraction from "fraction.js";
import {
  LOCALES,
  SCHEMA_VERSION,
  type Item,
  type Machine,
  type Recipe,
  type RecipePack,
  type RecipePackI18n,
  type Transport,
} from "./schema.ts";
import {
  CATALYST_BY_PRODUCER,
  ENVIRONMENT_BY_RECIPE,
  SKIP_SINK_RECIPES,
  WORLD_NODE_MACHINES,
  collapseSyntheticChains,
  main as runExtractor,
  splitCatalyst,
  validateReferentialIntegrity,
} from "./extract.ts";
import type { UpstreamData, UpstreamRecipe } from "./upstream.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TRANSPORT_CONFIG_PATH = resolve(REPO_ROOT, "data/aef/transport-config.json");

let pack: RecipePack;
let i18n: RecipePackI18n;
let droppedEventItems: string[];
let droppedEventRecipes: string[];
let upstream: UpstreamData;

beforeAll(async () => {
  // Build in-memory only; a test run must never rewrite the committed
  // data/aef/ artifacts.
  ({ pack, i18n, droppedEventItems, droppedEventRecipes } = await runExtractor({
    write: false,
  }));
  upstream = (await Bun.file(
    resolve(REPO_ROOT, "vendor/endfield-calc/data.json"),
  ).json()) as UpstreamData;
});

describe("schema and source provenance", () => {
  test("schemaVersion matches code constant", () => {
    expect(pack.schemaVersion).toBe(SCHEMA_VERSION);
  });

  test("source has 40-char SHA, valid game version, ISO timestamp", () => {
    expect(pack.source.name).toBe("endfield-calc/factoriolab");
    expect(pack.source.sourceRepo).toBe("https://github.com/endfield-calc/factoriolab");
    expect(pack.source.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pack.source.gameVersion).toMatch(/^v\d+\.\d+(\.\d+)?$/);
    expect(pack.source.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
});

describe("counts", () => {
  test("expected counts for AEF v1.5.3 after synthetic-chain collapse", () => {
    // Synthetic collapse drops __miner_water (item), __miner_pump_1 (machine),
    // and the __miner_water identity recipe.
    //
    // These counts also guard the two hand tables. Dropping an id upstream
    // fails loudly: the extractor throws on a WORLD_NODE_MACHINES machine or a
    // SKIP_SINK_RECIPES recipe that is missing. Adding one does not - a new
    // purification gate or cleaner sink upstream shows up only as a machine or
    // recipe count that moved here. When a count moves, check those tables
    // before re-pinning the number.
    expect(pack.items).toHaveLength(113);
    expect(pack.machines).toHaveLength(33);
    // Two upstream transports (belt, pipe) plus the synthetic gas carrier.
    expect(pack.transports).toHaveLength(3);
    expect(pack.recipes).toHaveLength(242);
    expect(pack.categories).toHaveLength(5);
    expect(pack.locations).toHaveLength(2);
  });
});

describe("id-set disjointness and uniqueness", () => {
  test("items, machines, and transports have no overlapping ids", () => {
    const ids = new Set<string>();
    for (const row of [...pack.items, ...pack.machines, ...pack.transports]) {
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
    expect(ids.size).toBe(pack.items.length + pack.machines.length + pack.transports.length);
  });
});

describe("referential integrity", () => {
  test("every recipe.locations entry, when present, is a known location", () => {
    const locIds = new Set(pack.locations.map((l) => l.id));
    for (const r of pack.recipes) {
      if (!r.locations) continue;
      for (const loc of r.locations) expect(locIds.has(loc)).toBe(true);
    }
  });

  test("every machine.locations entry, when present, is a known location", () => {
    const locIds = new Set(pack.locations.map((l) => l.id));
    for (const m of pack.machines) {
      if (!m.locations) continue;
      for (const loc of m.locations) expect(locIds.has(loc)).toBe(true);
    }
  });
});

describe("invariants", () => {
  test("recipe time >= 1", () => {
    for (const r of pack.recipes) expect(r.time).toBeGreaterThanOrEqual(1);
  });

  test("stoichiometry quantities are positive", () => {
    // v1.4 introduced fractional quantities (phase-transition recipes consume
    // 0.2 xiranite per cycle), so the old >= 1 floor no longer holds.
    for (const r of pack.recipes) {
      for (const s of [...r.in, ...r.out]) expect(s.qty).toBeGreaterThan(0);
    }
  });

  test("no recipe consumes an item it also produces", () => {
    // The two phase-transition recipes that used to land here draw their own
    // output as a catalyst, and the catalyst split moves that draw off `in`,
    // so nothing is left for the solver boundary to net away.
    const offenders = pack.recipes
      .filter((r) => {
        const inIds = new Set(r.in.map((s) => s.item));
        return r.out.some((s) => inIds.has(s.item));
      })
      .map((r) => r.id)
      .sort();
    expect(offenders).toEqual([]);
  });

  test("only liquid_*/gas_* items lack a stack size after synthetic collapse", () => {
    const noStack = pack.items.filter((i) => i.stack === undefined).map((i) => i.id);
    expect(noStack).toHaveLength(19);
    for (const id of noStack) {
      expect(id.startsWith("liquid_") || id.startsWith("gas_")).toBe(true);
    }
  });
});

describe("transmuter catalysts", () => {
  // Every recipe whose sole producer is a phase transmuter draws xiranite as a
  // catalyst: the machine cycles it rather than consuming it, so the extractor
  // lifts that draw off `in` into its own `catalyst` array.
  const FOLDED = ["phase_trans_1-gas_xiranite", "phase_trans_2-xiranite_powder"];

  test("exactly the 22 single-transmuter recipes carry a catalyst", () => {
    const carriers = pack.recipes.filter((r) => r.catalyst !== undefined).map((r) => r.id);
    expect(carriers).toHaveLength(22);
    const expected = pack.recipes
      .filter((r) => r.producers.length === 1 && CATALYST_BY_PRODUCER[r.producers[0]!] !== undefined)
      .map((r) => r.id);
    expect(carriers.sort()).toEqual(expected.sort());
  });

  test("each catalyst is a single entry for the producer's xiranite phase", () => {
    for (const r of pack.recipes) {
      if (!r.catalyst) continue;
      expect(r.producers).toHaveLength(1);
      const item = CATALYST_BY_PRODUCER[r.producers[0]!];
      expect(r.catalyst).toHaveLength(1);
      expect(r.catalyst[0]!.item).toBe(item!);
    }
  });

  test("every catalyst draw is exactly 6 per minute at machine speed 1", () => {
    // Exact rational comparison: the emitted 0.2 must round-trip to 1/5, not to
    // a float that only prints like it.
    for (const r of pack.recipes) {
      if (!r.catalyst) continue;
      const rate = new Fraction(r.catalyst[0]!.qty).mul(60).div(r.time);
      expect(rate.equals(6)).toBe(true);
    }
  });

  test("catalyst quantities are 0.2 per 2s cycle and 1 per 10s cycle", () => {
    const short = pack.recipes.filter((r) => r.catalyst && r.time === 2);
    const long = pack.recipes.filter((r) => r.catalyst && r.time === 10);
    expect(short).toHaveLength(18);
    expect(long).toHaveLength(4);
    for (const r of short) expect(r.catalyst![0]!.qty).toBe(0.2);
    for (const r of long) expect(r.catalyst![0]!.qty).toBe(1);
  });

  test("the catalyst item survives on `in` only where upstream folded a feed draw", () => {
    const overlap = pack.recipes
      .filter((r) => r.catalyst && r.in.some((s) => s.item === r.catalyst![0]!.item))
      .map((r) => r.id)
      .sort();
    expect(overlap).toEqual([...FOLDED].sort());
  });

  test("phase_trans_1-gas_xiranite: folded 1.2 splits into feed 1 plus catalyst 0.2", () => {
    const r = pack.recipes.find((x) => x.id === "phase_trans_1-gas_xiranite");
    expect(r).toBeDefined();
    expect(r!.in).toEqual([{ item: "liquid_xiranite", qty: 1 }]);
    expect(r!.catalyst).toEqual([{ item: "liquid_xiranite", qty: 0.2 }]);
    expect(r!.out).toEqual([{ item: "gas_xiranite", qty: 1 }]);
  });

  test("phase_trans_2-xiranite_powder: folded 1.2 splits into feed 1 plus catalyst 0.2", () => {
    const r = pack.recipes.find((x) => x.id === "phase_trans_2-xiranite_powder");
    expect(r).toBeDefined();
    expect(r!.in).toEqual([{ item: "gas_xiranite", qty: 1 }]);
    expect(r!.catalyst).toEqual([{ item: "gas_xiranite", qty: 0.2 }]);
    expect(r!.out).toEqual([{ item: "xiranite_powder", qty: 1 }]);
  });

  test("phase_trans_1-liquid_xiranite: catalyst draw of its own output leaves `in` clean", () => {
    const r = pack.recipes.find((x) => x.id === "phase_trans_1-liquid_xiranite");
    expect(r).toBeDefined();
    expect(r!.in).toEqual([{ item: "gas_xiranite", qty: 1 }]);
    expect(r!.catalyst).toEqual([{ item: "liquid_xiranite", qty: 0.2 }]);
    expect(r!.out).toEqual([{ item: "liquid_xiranite", qty: 1 }]);
  });

  test("phase_trans_2-gas_xiranite: catalyst draw of its own output leaves `in` clean", () => {
    const r = pack.recipes.find((x) => x.id === "phase_trans_2-gas_xiranite");
    expect(r).toBeDefined();
    expect(r!.in).toEqual([{ item: "xiranite_powder", qty: 1 }]);
    expect(r!.catalyst).toEqual([{ item: "gas_xiranite", qty: 0.2 }]);
    expect(r!.out).toEqual([{ item: "gas_xiranite", qty: 1 }]);
  });

  test("the split never empties a recipe's `in`", () => {
    for (const r of pack.recipes) {
      if (!r.catalyst) continue;
      expect(r.in.length).toBeGreaterThan(0);
    }
  });
});

describe("splitCatalyst guards", () => {
  // Smallest upstream recipe the split reads: producers pick the catalyst
  // phase, time sets the charge, and `in` carries the folded draw.
  const makeUpstream = (
    over: Partial<UpstreamRecipe> & Pick<UpstreamRecipe, "id">,
  ): UpstreamRecipe => ({
    name: over.id,
    category: "material",
    row: 0,
    icon: over.id,
    time: 2,
    in: { liquid_xiranite: 1.2 },
    out: { gas_xiranite: 1 },
    producers: ["phase_trans_1"],
    ...over,
  });

  test("splits a folded transmuter draw into feed plus catalyst", () => {
    const inputs = [{ item: "liquid_xiranite", qty: 1.2 }];
    expect(splitCatalyst(makeUpstream({ id: "ok" }), inputs)).toEqual([
      { item: "liquid_xiranite", qty: 0.2 },
    ]);
    expect(inputs).toEqual([{ item: "liquid_xiranite", qty: 1 }]);
  });

  test("throws when a transmuter recipe gains a second producer", () => {
    // A silent `undefined` here would ship the charge as an ordinary input and
    // double-count the cycled xiranite, so a widened producer list has to fail
    // the extract instead.
    const u = makeUpstream({
      id: "two_producers",
      producers: ["phase_trans_1", "phase_trans_2"],
    });
    expect(() => splitCatalyst(u, [{ item: "liquid_xiranite", qty: 1.2 }])).toThrow(
      "recipe two_producers lists 2 producers but phase_trans_1 cycles a catalyst",
    );
  });

  test("throws when the split would empty a recipe's `in`", () => {
    // An input-less recipe reads as a map deposit downstream and gets banned
    // from every solution, so an all-catalyst draw must fail loudly here.
    const u = makeUpstream({ id: "charge_only", in: { liquid_xiranite: 0.2 } });
    expect(() => splitCatalyst(u, [{ item: "liquid_xiranite", qty: 0.2 }])).toThrow(
      "recipe charge_only draws nothing but its catalyst charge",
    );
  });
});

describe("recipe environment", () => {
  test("environment is stamped on exactly the four table recipes", () => {
    const stamped = Object.fromEntries(
      pack.recipes.filter((r) => r.environment !== undefined).map((r) => [r.id, r.environment]),
    );
    expect(stamped).toEqual({
      "gas_copper_enr-gas_inert": "stable",
      "gas_xiranite_enr-gas_inert": "stable",
      "xiranite_powder-carbon_mtl": "stable",
      gas_copper_enr2: "acidic",
    });
    expect(stamped).toEqual(ENVIRONMENT_BY_RECIPE);
  });

  test("environmentBadges carry the reference recipes' icon ids", () => {
    expect(pack.environmentBadges).toEqual({ stable: "LESvbc0cp", acidic: "ynGeJZzIH" });
    const stable = pack.recipes.find((r) => r.id === "gas_copper_enr-gas_inert");
    const acidic = pack.recipes.find((r) => r.id === "gas_copper_enr2");
    expect(pack.environmentBadges.stable).toBe(stable!.icon);
    expect(pack.environmentBadges.acidic).toBe(acidic!.icon);
  });

  test("both badge icon ids resolve in the upstream sprite sheet", () => {
    const iconIds = new Set(upstream.icons.map((i) => i.id));
    expect(iconIds.has(pack.environmentBadges.stable)).toBe(true);
    expect(iconIds.has(pack.environmentBadges.acidic)).toBe(true);
  });
});

describe("known-good records", () => {
  test("originium_ore: mining recipe with empty in", () => {
    const r = pack.recipes.find((x) => x.id === "originium_ore");
    expect(r).toBeDefined();
    expect(r!.in).toEqual([]);
    expect(r!.out).toEqual([{ item: "originium_ore", qty: 1 }]);
    expect(r!.producers).toEqual(["miner_2", "miner_3"]);
    expect(r!.flags).toEqual(["mining"]);
    expect(r!.time).toBe(3);
  });

  test("liquid_plant_grass_1: multi-producer recipe", () => {
    const r = pack.recipes.find((x) => x.id === "liquid_plant_grass_1");
    expect(r).toBeDefined();
    expect(r!.producers).toEqual(["mix_pool_1", "mix_pool_2"]);
  });

  test("plant_grass_1: location-restricted to jinlong", () => {
    const r = pack.recipes.find((x) => x.id === "plant_grass_1");
    expect(r).toBeDefined();
    expect(r!.locations).toEqual(["jinlong"]);
  });

  test("power_originium_ore: gen-power recipe with negative usage and empty out", () => {
    const r = pack.recipes.find((x) => x.id === "power_originium_ore");
    expect(r).toBeDefined();
    expect(r!.category).toBe("gen-power");
    expect(r!.usage).toBe(-50);
    expect(r!.out).toEqual([]);
    expect(r!.in).toEqual([{ item: "originium_ore", qty: 1 }]);
  });

  test("liquid_cleaner_1-sewage: sink recipe with cost=-1 and positive usage", () => {
    const r = pack.recipes.find((x) => x.id === "liquid_cleaner_1-sewage");
    expect(r).toBeDefined();
    expect(r!.cost).toBe(-1);
    expect(r!.usage).toBe(50);
    expect(r!.out).toEqual([]);
  });

  test("__domain_transfer machine: hideRate=true, no size", () => {
    const m = pack.machines.find((x) => x.id === "__domain_transfer");
    expect(m).toBeDefined();
    expect(m!.hideRate).toBe(true);
    expect(m!.size).toBeUndefined();
  });

  test("miner_4 machine: burner powerType, powerKw null", () => {
    const m = pack.machines.find((x) => x.id === "miner_4");
    expect(m).toBeDefined();
    expect(m!.powerType).toBe("burner");
    expect(m!.powerKw).toBeNull();
  });

  test("power_sta_1 machine: 2x2 footprint", () => {
    const m = pack.machines.find((x) => x.id === "power_sta_1");
    expect(m).toBeDefined();
    expect(m!.size).toEqual([2, 2]);
  });

  test("miner_2 machine: totalRecipe=true", () => {
    const m = pack.machines.find((x) => x.id === "miner_2");
    expect(m).toBeDefined();
    expect(m!.totalRecipe).toBe(true);
  });

  test("transports include belt 0.5/s and pipe 2/s", () => {
    const belt = pack.transports.find((x) => x.id === "belt");
    const pipe = pack.transports.find((x) => x.id === "pipe");
    expect(belt).toEqual({ id: "belt", kind: "belt", name: belt!.name, icon: "belt", speed: 0.5 });
    expect(pipe).toEqual({ id: "pipe", kind: "pipe", name: pipe!.name, icon: "pipe", speed: 2 });
  });
});

describe("optional-field counts", () => {
  test("9 recipes carry a usage override", () => {
    expect(pack.recipes.filter((r) => r.usage !== undefined)).toHaveLength(9);
  });

  test("34 recipes carry a cost hint", () => {
    expect(pack.recipes.filter((r) => r.cost !== undefined)).toHaveLength(34);
  });

  test("4 items carry a buildIcon", () => {
    expect(pack.items.filter((i) => i.buildIcon !== undefined)).toHaveLength(4);
  });

  test("21 machines carry a size, 19 carry locations, 3 carry totalRecipe", () => {
    // v1.4 adds the four gas-system machines (gas_pump_1, gas_reactor_1,
    // phase_trans_1, phase_trans_2), all sized and jinlong-restricted.
    expect(pack.machines.filter((m) => m.size !== undefined)).toHaveLength(21);
    expect(pack.machines.filter((m) => m.locations !== undefined)).toHaveLength(19);
    expect(pack.machines.filter((m) => m.totalRecipe !== undefined)).toHaveLength(3);
  });

  test("exactly two burner machines (gas_pump_1, miner_4); all others electric", () => {
    const burners = pack.machines
      .filter((m) => m.powerType === "burner")
      .map((m) => m.id)
      .sort();
    expect(burners).toEqual(["gas_pump_1", "miner_4"]);
    for (const m of pack.machines.filter((m) => m.powerType === "electric")) {
      expect(m.powerKw).not.toBeNull();
    }
  });
});

describe("order preservation", () => {
  test("first item, first machine, first recipe match upstream order", () => {
    expect(pack.items[0]?.id).toBe("plant_moss_seed_1");
    expect(pack.machines[0]?.id).toBe("__domain_transfer");
    expect(pack.recipes[0]?.id).toBe("plant_moss_seed_1");
    expect(pack.categories[0]?.id).toBe("material");
    expect(pack.locations[0]?.id).toBe("tundra");
  });
});

describe("synthetic-chain collapse", () => {
  test("__miner_water item and __miner_water identity recipe are dropped", () => {
    expect(pack.items.find((i) => i.id === "__miner_water")).toBeUndefined();
    expect(pack.recipes.find((r) => r.id === "__miner_water")).toBeUndefined();
  });

  test("__miner_pump_1 machine is dropped", () => {
    expect(pack.machines.find((m) => m.id === "__miner_pump_1")).toBeUndefined();
  });

  test("copper_ore-liquid_water input is rewritten to liquid_water", () => {
    const r = pack.recipes.find((x) => x.id === "copper_ore-liquid_water");
    expect(r).toBeDefined();
    expect(r!.in).toEqual([{ item: "liquid_water", qty: 1 }]);
    expect(r!.producers).toEqual(["miner_4"]);
  });
});

describe("raw classification", () => {
  test("the exact raw-item set matches the curated expected list", () => {
    const expected = new Set([
      "originium_ore",
      "quartz_sand",
      "iron_ore",
      "liquid_water",
      "liquid_acid",
      "copper_ore",
      "domain_key_tundra",
      // v1.4: gas-pump collection recipes carry the mining flag, so these
      // classify raw via rule (a) exactly like copper_ore.
      "gas_xiranite",
      "gas_inert",
    ]);
    const got = new Set(pack.items.filter((i) => i.raw).map((i) => i.id));
    expect(got).toEqual(expected);
  });

  test("copper_ore is raw despite copper_ore-liquid_water having an input", () => {
    const copper = pack.items.find((i) => i.id === "copper_ore");
    expect(copper).toBeDefined();
    expect(copper!.raw).toBe(true);
    const r = pack.recipes.find((x) => x.id === "copper_ore-liquid_water");
    expect(r).toBeDefined();
    expect(r!.in.length).toBeGreaterThan(0);
    expect(r!.flags).toEqual(["mining"]);
  });

  test("domain_key_tundra is raw via orphan rule (no producer)", () => {
    const item = pack.items.find((i) => i.id === "domain_key_tundra");
    expect(item).toBeDefined();
    expect(item!.raw).toBe(true);
    const producers = pack.recipes.filter((r) => r.out.some((s) => s.item === "domain_key_tundra"));
    expect(producers).toEqual([]);
  });
});

describe("recipe flags", () => {
  test("the mining flag stays exactly the 8 upstream extractor recipes", () => {
    const mining = pack.recipes.filter((r) => r.flags?.includes("mining")).map((r) => r.id);
    expect(mining.sort()).toEqual(
      [
        "copper_ore-liquid_water",
        "gas_inert",
        "gas_xiranite",
        "iron_ore",
        "liquid_acid",
        "liquid_water",
        "originium_ore",
        "quartz_sand",
      ].sort(),
    );
  });

  test("world-node is stamped on exactly the two purification-node recipes", () => {
    const worldNode = pack.recipes.filter((r) => r.flags?.includes("world-node")).map((r) => r.id);
    expect(worldNode.sort()).toEqual(["sewage-treat", "sewage-treat-export"]);
  });

  test("world-node recipes keep their other fields and gain no cost hint", () => {
    const treat = pack.recipes.find((r) => r.id === "sewage-treat");
    expect(treat).toBeDefined();
    expect(treat!.flags).toEqual(["world-node"]);
    expect(treat!.producers).toEqual(["liquid_clean_gate"]);
    expect(treat!.cost).toBeUndefined();

    const exp = pack.recipes.find((r) => r.id === "sewage-treat-export");
    expect(exp).toBeDefined();
    expect(exp!.flags).toEqual(["world-node"]);
    expect(exp!.producers).toEqual(["liquid_recycle_gate"]);
    expect(exp!.cost).toBeUndefined();
  });

  test("a machine outside the world-node table leaves its recipes unflagged", () => {
    const r = pack.recipes.find((x) => x.id === "liquid_plant_grass_1");
    expect(r).toBeDefined();
    expect(r!.flags).toBeUndefined();
  });
});

describe("hand-pinned skip sentinels", () => {
  test("every WORLD_NODE_MACHINES id is a machine in the pack", () => {
    const machineIds = new Set(pack.machines.map((m) => m.id));
    for (const id of WORLD_NODE_MACHINES) {
      expect(machineIds.has(id)).toBe(true);
    }
  });

  test("every SKIP_SINK_RECIPES id is a recipe in the pack", () => {
    const recipeIds = new Set(pack.recipes.map((r) => r.id));
    for (const id of SKIP_SINK_RECIPES) {
      expect(recipeIds.has(id)).toBe(true);
    }
  });

  test("cost === -1 marks exactly the three liquid_cleaner_1 waste sinks", () => {
    const skipped = pack.recipes.filter((r) => r.cost === -1).map((r) => r.id);
    expect(skipped.sort()).toEqual(
      [
        "liquid_cleaner_1-sewage",
        "liquid_cleaner_1-xiranite_lowpoly",
        "liquid_cleaner_1-xiranite_poly",
      ].sort(),
    );
  });

  test("the pinned sinks keep the rest of their upstream shape", () => {
    for (const id of [
      "liquid_cleaner_1-sewage",
      "liquid_cleaner_1-xiranite_lowpoly",
      "liquid_cleaner_1-xiranite_poly",
    ]) {
      const r = pack.recipes.find((x) => x.id === id);
      expect(r).toBeDefined();
      expect(r!.out).toEqual([]);
      expect(r!.usage).toBe(50);
      expect(r!.producers).toEqual(["liquid_cleaner_1"]);
    }
  });
});

describe("retired event rows", () => {
  test("the dropped item set is exactly the eleven event items", () => {
    expect(droppedEventItems).toEqual([
      "activity_copper_poly",
      "activity_copper_poly_cmpt",
      "activity_copper_poly_gas",
      "activity_copper_poly_tool",
      "activity_copper_xiranite_tool",
      "activity_xiranite_box",
      "activity_xiranite_enr_box",
      "activity_xiranite_enr_lung",
      "activity_xiranite_enr_nugget",
      "activity_xiranite_lung",
      "activity_xiranite_nugget",
    ]);
  });

  test("the dropped recipe set is exactly the fourteen event recipes", () => {
    expect(droppedEventRecipes).toEqual([
      "activity_copper_poly_cmpt",
      "activity_copper_poly_gas",
      "activity_copper_poly_tool",
      "activity_copper_xiranite_tool",
      "activity_xiranite_box",
      "activity_xiranite_enr_box",
      "activity_xiranite_enr_lung",
      "activity_xiranite_enr_nugget",
      "activity_xiranite_lung",
      "activity_xiranite_nugget",
      "jinlong_coupon-activity_xiranite_enr_lung",
      "jinlong_coupon-activity_xiranite_lung",
      "phase_trans_2-activity_copper_poly",
      "phase_trans_2-activity_copper_poly_gas",
    ]);
  });

  test("no event id survives anywhere in the pack", () => {
    for (const item of pack.items) {
      expect(item.id.startsWith("activity_"), item.id).toBe(false);
    }
    for (const r of pack.recipes) {
      expect(r.id.startsWith("activity_"), r.id).toBe(false);
      for (const s of [...r.in, ...r.out]) {
        expect(s.item.startsWith("activity_"), `${r.id} -> ${s.item}`).toBe(false);
      }
    }
  });

  test("jinlong_coupon keeps its twelve producer recipes", () => {
    const producers = pack.recipes.filter((r) =>
      r.out.some((s) => s.item === "jinlong_coupon"),
    );
    expect(producers).toHaveLength(12);
  });

  test("the i18n sidecar carries no event key", () => {
    for (const locale of LOCALES) {
      const buckets = Object.values(i18n.names[locale]) as Record<string, string>[];
      for (const bucket of buckets) {
        for (const id of Object.keys(bucket)) {
          expect(id.startsWith("activity_"), `${locale}: ${id}`).toBe(false);
        }
      }
    }
  });
});

describe("transport-kind classification", () => {
  test("every Transport.kind has a carrier entry in transport-config.json", async () => {
    const transportConfig = (await Bun.file(TRANSPORT_CONFIG_PATH).json()) as {
      carriers: Record<string, unknown>;
    };
    const carrierKeys = new Set(Object.keys(transportConfig.carriers));
    for (const t of pack.transports) {
      expect(carrierKeys.has(t.kind)).toBe(true);
    }
  });

  test("liquid items classify as pipe, stacked items classify as belt", () => {
    const liquid = pack.items.find((i) => i.id === "liquid_water");
    expect(liquid).toBeDefined();
    expect(liquid!.transportKind).toBe("pipe");
    expect(liquid!.stack).toBeUndefined();

    const solid = pack.items.find((i) => i.id === "copper_ore");
    expect(solid).toBeDefined();
    expect(solid!.transportKind).toBe("belt");
    expect(typeof solid!.stack).toBe("number");
  });

  test("gas items classify as gas, not pipe", () => {
    const gas = pack.items.find((i) => i.id === "gas_copper");
    expect(gas).toBeDefined();
    expect(gas!.transportKind).toBe("gas");
    expect(gas!.stack).toBeUndefined();
  });

  test("the synthetic gas carrier is present so every item kind resolves", () => {
    const gasPipe = pack.transports.find((t) => t.id === "gas_pipe");
    expect(gasPipe).toBeDefined();
    expect(gasPipe!.kind).toBe("gas");
    expect(gasPipe!.speed).toBe(2);

    const kinds = new Set(pack.transports.map((t) => t.kind));
    for (const item of pack.items) {
      expect(kinds.has(item.transportKind)).toBe(true);
    }
  });

  test("the synthetic gas carrier is translated in every locale", () => {
    for (const locale of i18n.locales) {
      const name = i18n.names[locale]!.transports["gas_pipe"];
      expect(name).toBeDefined();
      expect(name!.length).toBeGreaterThan(0);
    }
  });

  test("every unstackable item splits cleanly between gas and pipe", () => {
    const unstackable = pack.items.filter((i) => i.stack === undefined);
    const byKind = { gas: [] as string[], pipe: [] as string[], other: [] as string[] };
    for (const i of unstackable) {
      if (i.transportKind === "gas") byKind.gas.push(i.id);
      else if (i.transportKind === "pipe") byKind.pipe.push(i.id);
      else byKind.other.push(i.id);
    }
    expect(byKind.other).toEqual([]);
    expect(byKind.gas.every((id) => id.startsWith("gas_"))).toBe(true);
    expect(byKind.pipe.some((id) => id.startsWith("gas_"))).toBe(false);
    expect(byKind.gas.length).toBeGreaterThan(0);
    expect(byKind.pipe.length).toBeGreaterThan(0);
  });
});

describe("idempotence", () => {
  test("re-running the extractor produces identical output, modulo extractedAt", async () => {
    const first = await runExtractor({ write: false });
    const second = await runExtractor({ write: false });

    const serialize = (v: unknown) =>
      JSON.stringify(v, null, 2).replace(/"extractedAt":\s*"[^"]+"/, '"extractedAt":"<elided>"');

    expect(serialize(second.pack)).toBe(serialize(first.pack));
    expect(serialize(second.i18n)).toBe(serialize(first.i18n));
  });
});

describe("i18n sidecar", () => {
  test("every name is a non-empty string", () => {
    for (const locale of LOCALES) {
      const buckets = Object.values(i18n.names[locale]) as Record<string, string>[];
      for (const bucket of buckets) {
        for (const [id, name] of Object.entries(bucket)) {
          expect(typeof name).toBe("string");
          expect(name.length).toBeGreaterThan(0);
          // Catch accidental key-as-value bugs by spot-checking that name and
          // id differ in at least one locale per id (unrealistic to match in
          // every locale by chance).
          if (locale === "en") {
            // en has the highest divergence from raw ids; assert there.
            expect(name).not.toBe(id);
          }
        }
      }
    }
  });

  test("known-good translations: belt + originium_ore + jinlong", () => {
    expect(i18n.names.en.transports.belt).toBe("Transport Belt");
    expect(i18n.names.zh.transports.belt).toBe("传送带");
    expect(i18n.names.en.recipes.originium_ore).toBe("Originium Ore");
    expect(i18n.names.en.locations.jinlong).toBe("Wuling");
    expect(i18n.names.en.locations.tundra).toBe("Valley IV");
  });
});

describe("collapseSyntheticChains guards", () => {
  // Build a minimally valid Item/Machine/Recipe for fixture use. The collapse
  // pass only inspects ids, producers, and in/out stoichiometry, so the other
  // fields just need to typecheck.
  const makeItem = (id: string): Item => ({
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    raw: false,
    transportKind: "belt",
  });
  const makeMachine = (id: string): Machine => ({
    id,
    name: id,
    icon: id,
    speed: 1,
    powerType: "electric",
    powerKw: 0,
    hideRate: false,
  });
  const makeRecipe = (
    id: string,
    inEntries: { item: string; qty: number }[],
    outEntries: { item: string; qty: number }[],
    producers: string[],
  ): Recipe => ({
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    time: 1,
    in: inEntries,
    out: outEntries,
    producers,
  });

  test("throws when a __-prefix reference survives the substitution pass", () => {
    // The substitution map covers __miner_water but NOT __miner_acid, so the
    // recipe's __miner_acid input survives and trips the post-pass guard.
    const items = [makeItem("__miner_water"), makeItem("liquid_water"), makeItem("acid_user_out")];
    const machines = [makeMachine("__miner_pump_1"), makeMachine("acid_user_machine")];
    const recipes = [
      // Identity recipe backing the __miner_water synthetic chain (gets dropped).
      makeRecipe(
        "__miner_water",
        [],
        [{ item: "__miner_water", qty: 1 }],
        ["__miner_pump_1"],
      ),
      // A recipe that references a synthetic id NOT in the substitution map.
      makeRecipe(
        "acid_user",
        [{ item: "__miner_acid", qty: 1 }],
        [{ item: "acid_user_out", qty: 1 }],
        ["acid_user_machine"],
      ),
    ];

    const subs = { __miner_water: "liquid_water" };

    expect(() => collapseSyntheticChains({ items, machines, recipes }, subs)).toThrow(
      "recipe acid_user still references synthetic item __miner_acid after collapse",
    );
  });

  test("throws when substitution would duplicate an existing entry on the same side", () => {
    // The recipe already lists liquid_water as an input alongside __miner_water.
    // Substituting __miner_water -> liquid_water would produce two liquid_water
    // entries on the in side, so the collision guard must fire.
    const items = [
      makeItem("__miner_water"),
      makeItem("liquid_water"),
      makeItem("mixed_out"),
    ];
    const machines = [makeMachine("__miner_pump_1"), makeMachine("mixer_machine")];
    const recipes = [
      // Identity recipe backing the __miner_water synthetic chain (gets dropped).
      makeRecipe(
        "__miner_water",
        [],
        [{ item: "__miner_water", qty: 1 }],
        ["__miner_pump_1"],
      ),
      // Collision-inducing recipe: both synthetic and real ids on the same side.
      makeRecipe(
        "mixer",
        [
          { item: "__miner_water", qty: 1 },
          { item: "liquid_water", qty: 2 },
        ],
        [{ item: "mixed_out", qty: 1 }],
        ["mixer_machine"],
      ),
    ];

    const subs = { __miner_water: "liquid_water" };

    expect(() => collapseSyntheticChains({ items, machines, recipes }, subs)).toThrow(
      "recipe mixer in collision: substituting __miner_water -> liquid_water would duplicate liquid_water",
    );
  });

  test("throws when a __-prefix reference survives on a catalyst entry", () => {
    // The substitution pass rewrites `in` / `out` only, so a synthetic id that
    // reached a catalyst array has to trip the post-pass guard rather than ship.
    const items = [makeItem("__miner_water"), makeItem("liquid_water"), makeItem("cat_out")];
    const machines = [makeMachine("__miner_pump_1"), makeMachine("cat_machine")];
    const recipes = [
      makeRecipe(
        "__miner_water",
        [],
        [{ item: "__miner_water", qty: 1 }],
        ["__miner_pump_1"],
      ),
      {
        ...makeRecipe(
          "cat_user",
          [{ item: "liquid_water", qty: 1 }],
          [{ item: "cat_out", qty: 1 }],
          ["cat_machine"],
        ),
        catalyst: [{ item: "__miner_acid", qty: 1 }],
      },
    ];

    const subs = { __miner_water: "liquid_water" };

    expect(() => collapseSyntheticChains({ items, machines, recipes }, subs)).toThrow(
      "recipe cat_user still references synthetic item __miner_acid after collapse",
    );
  });
});

describe("validateReferentialIntegrity guards", () => {
  // Smallest pack the validator accepts: one item on a belt, one machine that
  // produces it, one belt transport. Each test perturbs one id from here.
  const mkItem = (id: string): Item => ({
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    raw: true,
    transportKind: "belt",
  });
  const mkMachine = (id: string): Machine => ({
    id,
    name: id,
    icon: id,
    speed: 1,
    powerType: "electric",
    powerKw: 0,
    hideRate: false,
  });
  const mkTransport = (id: string): Transport => ({
    id,
    kind: "belt",
    name: id,
    icon: id,
    speed: 1,
  });
  const mkPack = () => ({
    items: [mkItem("widget")],
    machines: [mkMachine("assembler")],
    transports: [mkTransport("belt_1")],
    recipes: [
      {
        id: "make_widget",
        name: "make_widget",
        category: "material",
        icon: "make_widget",
        row: 0,
        time: 1,
        in: [],
        out: [{ item: "widget", qty: 1 }],
        producers: ["assembler"],
      } satisfies Recipe,
    ],
  });

  test("accepts a pack whose item, machine, and transport ids are disjoint", () => {
    expect(() => validateReferentialIntegrity(mkPack())).not.toThrow();
  });

  test("throws when a machine id is also a transport id", () => {
    const pack = mkPack();
    pack.transports = [mkTransport("assembler")];
    expect(() => validateReferentialIntegrity(pack)).toThrow(
      "id assembler appears as both a machine and a transport",
    );
  });

  test("throws when a catalyst entry names an unknown item", () => {
    const pack = mkPack();
    pack.recipes[0]!.catalyst = [{ item: "ghost", qty: 1 }];
    expect(() => validateReferentialIntegrity(pack)).toThrow(
      "recipe make_widget references unknown item ghost",
    );
  });
});
