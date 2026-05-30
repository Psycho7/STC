import { describe, expect, test, beforeAll } from "bun:test";
import { resolve } from "node:path";
import {
  LOCALES,
  SCHEMA_VERSION,
  type Item,
  type Machine,
  type Recipe,
  type RecipePack,
  type RecipePackI18n,
} from "./schema.ts";
import { collapseSyntheticChains, main as runExtractor } from "./extract.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PACK_PATH = resolve(REPO_ROOT, "data/aef/recipe-pack.json");
const I18N_PATH = resolve(REPO_ROOT, "data/aef/recipe-pack.i18n.json");
const TRANSPORT_CONFIG_PATH = resolve(REPO_ROOT, "data/aef/transport-config.json");
const TRANSPORT_CONFIG_SCHEMA_PATH = resolve(REPO_ROOT, "data/aef/transport-config.schema.json");

let pack: RecipePack;
let i18n: RecipePackI18n;

beforeAll(async () => {
  await runExtractor();
  pack = (await Bun.file(PACK_PATH).json()) as RecipePack;
  i18n = (await Bun.file(I18N_PATH).json()) as RecipePackI18n;
});

describe("schema and source provenance", () => {
  test("schemaVersion matches code constant", () => {
    expect(pack.schemaVersion).toBe(SCHEMA_VERSION);
  });

  test("source has 40-char SHA, valid game version, ISO timestamp", () => {
    expect(pack.source.name).toBe("endfield-calc/factoriolab");
    expect(pack.source.sourceRepo).toBe("https://github.com/endfield-calc/factoriolab");
    expect(pack.source.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(pack.source.gameVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pack.source.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
});

describe("counts", () => {
  test("expected counts for AEF v1.2.4 after synthetic-chain collapse", () => {
    // Synthetic collapse drops __miner_water (item), __miner_pump_1 (machine),
    // and the __miner_water identity recipe.
    expect(pack.items).toHaveLength(100);
    expect(pack.machines).toHaveLength(29);
    expect(pack.transports).toHaveLength(2);
    expect(pack.recipes).toHaveLength(206);
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

  test("recipe ids are unique", () => {
    const ids = new Set(pack.recipes.map((r) => r.id));
    expect(ids.size).toBe(pack.recipes.length);
  });
});

describe("referential integrity", () => {
  test("every recipe in/out item resolves to an item (not a machine or transport)", () => {
    const itemIds = new Set(pack.items.map((i) => i.id));
    for (const r of pack.recipes) {
      for (const s of [...r.in, ...r.out]) {
        expect(itemIds.has(s.item)).toBe(true);
      }
    }
  });

  test("every producer resolves to a machine", () => {
    const machineIds = new Set(pack.machines.map((m) => m.id));
    for (const r of pack.recipes) {
      expect(r.producers.length).toBeGreaterThan(0);
      for (const p of r.producers) {
        expect(machineIds.has(p)).toBe(true);
      }
    }
  });

  test("every Item.transportKind value resolves to a Transport.kind in the pack (asserted by validateReferentialIntegrity)", () => {
    const transportKinds = new Set(pack.transports.map((t) => t.kind));
    for (const item of pack.items) {
      expect(transportKinds.has(item.transportKind)).toBe(true);
    }
  });

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

  test("stoichiometry quantities >= 1", () => {
    for (const r of pack.recipes) {
      for (const s of [...r.in, ...r.out]) expect(s.qty).toBeGreaterThanOrEqual(1);
    }
  });

  test("transport speeds are positive", () => {
    for (const t of pack.transports) expect(t.speed).toBeGreaterThan(0);
  });

  test("recipe in/out item sets are disjoint (no catalysts in AEF)", () => {
    for (const r of pack.recipes) {
      const inIds = new Set(r.in.map((s) => s.item));
      for (const s of r.out) expect(inIds.has(s.item)).toBe(false);
    }
  });

  test("only liquid_* items lack a stack size after synthetic collapse", () => {
    const noStack = pack.items.filter((i) => i.stack === undefined).map((i) => i.id);
    expect(noStack).toHaveLength(11);
    for (const id of noStack) {
      expect(id.startsWith("liquid_")).toBe(true);
    }
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

  test("27 recipes carry a cost hint", () => {
    expect(pack.recipes.filter((r) => r.cost !== undefined)).toHaveLength(27);
  });

  test("4 items carry a buildIcon", () => {
    expect(pack.items.filter((i) => i.buildIcon !== undefined)).toHaveLength(4);
  });

  test("17 machines carry a size, 15 carry locations, 3 carry totalRecipe", () => {
    // 14 upstream minus dropped __miner_pump_1 (jinlong-only) plus the two new
    // sewage-treatment gates (liquid_clean_gate, liquid_recycle_gate, both jinlong).
    expect(pack.machines.filter((m) => m.size !== undefined)).toHaveLength(17);
    expect(pack.machines.filter((m) => m.locations !== undefined)).toHaveLength(15);
    expect(pack.machines.filter((m) => m.totalRecipe !== undefined)).toHaveLength(3);
  });

  test("exactly one burner machine (miner_4); all others electric", () => {
    const burners = pack.machines.filter((m) => m.powerType === "burner");
    expect(burners).toHaveLength(1);
    expect(burners[0]?.id).toBe("miner_4");
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
  test("no __-prefix stoichiometric entries remain on any recipe", () => {
    for (const r of pack.recipes) {
      for (const s of [...r.in, ...r.out]) {
        expect(s.item.startsWith("__")).toBe(false);
      }
    }
  });

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

  test("every Item carries a raw flag", () => {
    for (const item of pack.items) {
      expect(typeof item.raw).toBe("boolean");
    }
  });
});

describe("transport-kind classification", () => {
  test("every Item carries a transportKind", () => {
    for (const item of pack.items) {
      expect(typeof item.transportKind).toBe("string");
      expect(item.transportKind.length).toBeGreaterThan(0);
    }
  });

  test("every Item.transportKind resolves to a Transport.kind in the pack", () => {
    const transportKinds = new Set(pack.transports.map((t) => t.kind));
    for (const item of pack.items) {
      expect(transportKinds.has(item.transportKind)).toBe(true);
    }
  });

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
});

describe("transport-config schema and document", () => {
  test("transport-config.json schemaVersion is 0.2", async () => {
    const cfg = (await Bun.file(TRANSPORT_CONFIG_PATH).json()) as { schemaVersion: string };
    expect(cfg.schemaVersion).toBe("0.2");
  });

  test("transport-config.json validates against its schema for arbitrary string carrier keys", async () => {
    const cfg = (await Bun.file(TRANSPORT_CONFIG_PATH).json()) as {
      schemaVersion: unknown;
      source: unknown;
      lanesPerBlueprintGroup: unknown;
      interGroupGapTiles: unknown;
      carriers: Record<string, { transportId: unknown; itemsPerSecondPerLane: unknown }>;
    };
    const schema = (await Bun.file(TRANSPORT_CONFIG_SCHEMA_PATH).json()) as {
      required: string[];
      properties: { carriers: { required?: string[]; additionalProperties?: boolean; patternProperties?: Record<string, unknown> } };
    };

    // Minimal structural checks: the document matches the relaxed schema shape.
    expect(schema.required).toEqual([
      "schemaVersion",
      "source",
      "lanesPerBlueprintGroup",
      "interGroupGapTiles",
      "carriers",
    ]);
    expect(schema.properties.carriers.required).toBeUndefined();
    expect(schema.properties.carriers.additionalProperties).toBeUndefined();
    expect(schema.properties.carriers.patternProperties).toBeDefined();

    // Each carrier entry has the required value shape.
    for (const [key, entry] of Object.entries(cfg.carriers)) {
      expect(key.length).toBeGreaterThan(0);
      expect(typeof entry.transportId).toBe("string");
      expect(typeof entry.itemsPerSecondPerLane).toBe("number");
      expect(entry.itemsPerSecondPerLane as number).toBeGreaterThan(0);
    }
  });
});

describe("idempotence", () => {
  test("re-running the extractor produces identical output, modulo extractedAt", async () => {
    const beforePack = await Bun.file(PACK_PATH).text();
    const beforeI18n = await Bun.file(I18N_PATH).text();
    await runExtractor();
    const afterPack = await Bun.file(PACK_PATH).text();
    const afterI18n = await Bun.file(I18N_PATH).text();

    const stripExtractedAt = (s: string) =>
      s.replace(/"extractedAt":\s*"[^"]+"/, '"extractedAt":"<elided>"');

    expect(stripExtractedAt(afterPack)).toBe(stripExtractedAt(beforePack));
    expect(stripExtractedAt(afterI18n)).toBe(stripExtractedAt(beforeI18n));
  });
});

describe("i18n sidecar", () => {
  test("schemaVersion and source provenance match the recipe-pack", () => {
    expect(i18n.schemaVersion).toBe(SCHEMA_VERSION);
    expect(i18n.source.name).toBe(pack.source.name);
    expect(i18n.source.sourceRepo).toBe(pack.source.sourceRepo);
    expect(i18n.source.sourceCommit).toBe(pack.source.sourceCommit);
    expect(i18n.source.gameVersion).toBe(pack.source.gameVersion);
  });

  test("locales array matches the LOCALES constant", () => {
    expect(i18n.locales).toEqual([...LOCALES]);
    expect(Object.keys(i18n.names).sort()).toEqual([...LOCALES].sort());
  });

  test("every locale covers every recipe-pack id, no orphans", () => {
    const expected = {
      categories: new Set(pack.categories.map((c) => c.id)),
      locations: new Set(pack.locations.map((l) => l.id)),
      items: new Set(pack.items.map((i) => i.id)),
      machines: new Set(pack.machines.map((m) => m.id)),
      transports: new Set(pack.transports.map((t) => t.id)),
      recipes: new Set(pack.recipes.map((r) => r.id)),
    } as const;

    for (const locale of LOCALES) {
      const got = i18n.names[locale];
      for (const kind of Object.keys(expected) as (keyof typeof expected)[]) {
        const gotIds = new Set(Object.keys(got[kind]));
        expect(gotIds).toEqual(expected[kind]);
      }
    }
  });

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
});
