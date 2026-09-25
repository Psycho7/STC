// @vitest-environment jsdom
//
// The availability model: the cohort effective-state rule (override wins in
// both directions; absent one, on iff the cohort matches the pack's own
// version), the cause map the three predicates compose into, the unavailable-id
// derivation that feeds the solver seam, pack-cohort truncation from
// provenance, and the localStorage read/write pair - whose read side must
// survive any malformed stored value, since the key is attacker-controllable
// browser state.
import { afterEach, describe, expect, it } from "vitest";
import type { Item, Machine, Recipe, RecipePack, Stoich } from "@aef/schema";
import {
  availabilityKey,
  effectiveCohortEnabled,
  eventCohortsOf,
  packCohortOf,
  latestArea,
  readStoredArea,
  readStoredEventOverrides,
  unavailableCauses,
  unavailableEventItems,
  unavailableItems,
  unavailableRecipeIds,
  writeStoredArea,
  writeStoredEventOverrides,
  type AvailabilitySettings,
} from "./availability";
import { pack as shippedPack } from "./load";
import {
  AREA_STORAGE_KEY,
  EVENT_COHORT_OVERRIDES_STORAGE_KEY,
} from "./storage-keys";

// The settings the app hands the core, with only the cohort overrides set: the
// area and manual fields are absent, so their predicates pass.
function eventsOnly(
  eventOverrides: AvailabilitySettings["eventOverrides"] = {},
): AvailabilitySettings {
  return { eventOverrides };
}

afterEach(() => {
  window.localStorage.clear();
});

// A pack small enough to reason about: one plain recipe, one recipe per event
// cohort (v1.2 off by default, v1.5 on because it matches the pack version),
// plus one item tagged with a cohort no recipe carries, to pin that cohorts
// are collected from items and recipes alike.
function fixturePack(gameVersion = "v1.5.3"): RecipePack {
  const stoich = (item: string, qty: number): Stoich => ({ item, qty });
  const item = (id: string, event?: string): Item => ({
    id,
    name: id,
    category: "cat",
    icon: id,
    row: 0,
    raw: id === "ore",
    transportKind: "belt",
    ...(event !== undefined ? { event } : {}),
  });
  const recipe = (id: string, out: string, event?: string): Recipe => ({
    id,
    name: id,
    category: "cat",
    icon: id,
    row: 0,
    time: 1,
    in: [stoich("ore", 1)],
    out: [stoich(out, 1)],
    producers: ["machine"],
    ...(event !== undefined ? { event } : {}),
  });
  return {
    schemaVersion: "0.2",
    source: {
      name: "micro",
      sourceRepo: "",
      sourceCommit: "",
      gameVersion,
      extractedAt: "",
    },
    categories: [{ id: "cat", name: "cat", icon: "cat" }],
    locations: [],
    items: [
      item("ore"),
      item("bar"),
      item("coin", "v1.2"),
      item("lung", "v1.5"),
      item("token_orphan", "v1.1"),
    ],
    machines: [
      {
        id: "machine",
        name: "machine",
        icon: "machine",
        speed: 1,
        powerType: "electric",
        powerKw: 1,
        hideRate: false,
      },
    ],
    transports: [],
    recipes: [
      recipe("smelt", "bar"),
      recipe("mint_coin", "coin", "v1.2"),
      recipe("grow_lung", "lung", "v1.5"),
    ],
  };
}

describe("packCohortOf", () => {
  it("truncates the patch off the pack's game version", () => {
    expect(packCohortOf(fixturePack("v1.5.3"))).toBe("v1.5");
    expect(packCohortOf(fixturePack("v1.5"))).toBe("v1.5");
    expect(packCohortOf(fixturePack("v2.10.1"))).toBe("v2.10");
  });

  it("throws on a malformed version - it is our own build artifact", () => {
    for (const bad of ["1.5", "v1", "v1.5.3.4", "v1.5-beta", ""]) {
      expect(() => packCohortOf(fixturePack(bad))).toThrow(/game version/);
    }
  });
});

describe("eventCohortsOf", () => {
  it("collects distinct cohorts from items and recipes, sorted", () => {
    // v1.1 appears on an item only, v1.2 on both, v1.5 on both.
    expect(eventCohortsOf(fixturePack())).toEqual(["v1.1", "v1.2", "v1.5"]);
  });

  it("is empty for a pack with no event content", () => {
    const pack = fixturePack();
    pack.items = pack.items.filter((i) => i.event === undefined);
    pack.recipes = pack.recipes.filter((r) => r.event === undefined);
    expect(eventCohortsOf(pack)).toEqual([]);
  });
});

describe("effectiveCohortEnabled", () => {
  it("lets an explicit override win in both directions", () => {
    // On-cohort forced off, off-cohort forced on: the override decides.
    expect(effectiveCohortEnabled("v1.5", "v1.5", { "v1.5": false })).toBe(
      false,
    );
    expect(effectiveCohortEnabled("v1.2", "v1.5", { "v1.2": true })).toBe(true);
  });

  it("falls back to cohort === packCohort when no override is stored", () => {
    expect(effectiveCohortEnabled("v1.5", "v1.5", {})).toBe(true);
    expect(effectiveCohortEnabled("v1.2", "v1.5", {})).toBe(false);
  });

  it("ignores overrides for other cohorts", () => {
    expect(effectiveCohortEnabled("v1.5", "v1.5", { "v1.2": true })).toBe(true);
    expect(effectiveCohortEnabled("v1.2", "v1.5", { "v1.5": true })).toBe(
      false,
    );
  });
});

// A pack whose location carriers are both exercised: `smelt` is tagged for
// the tundra alone, and `mint_coin` runs on a machine that only exists in
// jinlong. Everything else is untagged, which means everywhere.
function locatedPack(): RecipePack {
  const pack = fixturePack();
  const jinlongMachine: Machine = {
    ...pack.machines[0]!,
    id: "machine_jinlong",
    locations: ["jinlong"],
  };
  pack.machines = [...pack.machines, jinlongMachine];
  pack.recipes = pack.recipes.map((r) =>
    r.id === "smelt"
      ? { ...r, locations: ["tundra"] }
      : r.id === "mint_coin"
        ? { ...r, producers: ["machine_jinlong"] }
        : r,
  );
  return pack;
}

describe("unavailableCauses", () => {
  it("passes every predicate whose settings field is absent", () => {
    // Cohorts all on, no area, no manual set: the location carriers in the
    // pack are inert and nothing is unavailable.
    expect(
      unavailableCauses(locatedPack(), eventsOnly({ "v1.2": true })),
    ).toEqual(new Map());
  });

  it("reports an area cause for both location carriers", () => {
    const causes = unavailableCauses(locatedPack(), {
      eventOverrides: { "v1.2": true },
      area: "jinlong",
    });
    // smelt is tundra-tagged on an untagged machine; grow_lung is untagged but
    // runs on the untagged machine, so it survives.
    expect(causes.get("smelt")).toEqual({ kind: "area", area: "jinlong" });
    expect(causes.has("grow_lung")).toBe(false);

    const tundra = unavailableCauses(locatedPack(), {
      eventOverrides: { "v1.2": true },
      area: "tundra",
    });
    // mint_coin is untagged on a jinlong-only machine: the machine carrier
    // excludes it.
    expect(tundra.get("mint_coin")).toEqual({ kind: "area", area: "tundra" });
    expect(tundra.has("smelt")).toBe(false);
  });

  it("keeps a recipe whose producers disagree about a location", () => {
    const pack = locatedPack();
    pack.recipes = pack.recipes.map((r) =>
      r.id === "mint_coin"
        ? { ...r, producers: ["machine_jinlong", "machine"] }
        : r,
    );
    // One producer is jinlong-only, the other is everywhere: some producer
    // stands in the tundra, so the recipe stays available.
    expect(
      unavailableCauses(pack, {
        eventOverrides: { "v1.2": true },
        area: "tundra",
      }).has("mint_coin"),
    ).toBe(false);
  });

  it("reports a manual cause naming the recipe", () => {
    expect(
      unavailableCauses(fixturePack(), {
        eventOverrides: { "v1.2": true },
        disabledRecipeIds: new Set(["smelt"]),
      }),
    ).toEqual(new Map([["smelt", { kind: "manual", recipeId: "smelt" }]]));
  });

  it("prefers the area cause when area and event both fail", () => {
    // mint_coin is off-cohort by default AND out of area under tundra.
    expect(
      unavailableCauses(locatedPack(), {
        eventOverrides: {},
        area: "tundra",
      }).get("mint_coin"),
    ).toEqual({ kind: "area", area: "tundra" });
  });

  it("prefers the event cause when event and manual both fail", () => {
    expect(
      unavailableCauses(fixturePack(), {
        eventOverrides: {},
        disabledRecipeIds: new Set(["mint_coin"]),
      }).get("mint_coin"),
    ).toEqual({ kind: "event", cohort: "v1.2" });
  });
});

// The area rule against the pack we actually ship (#124). The counts are the
// measured fallout of decision 3 and are meant to move only when the pack does:
// a bump that changes them is a fact about the game, to be re-measured and
// re-stated here rather than loosened into an inequality.
describe("unavailableCauses - area over the shipped pack", () => {
  const TOTAL_RECIPES = 256;

  function survivingIds(area?: string): string[] {
    const causes = unavailableCauses(shippedPack, {
      eventOverrides: {},
      ...(area !== undefined ? { area } : {}),
    });
    return shippedPack.recipes.map((r) => r.id).filter((id) => !causes.has(id));
  }

  it("keeps 180 of 256 recipes in the tundra and 242 in jinlong", () => {
    expect(shippedPack.recipes).toHaveLength(TOTAL_RECIPES);
    expect(survivingIds("tundra")).toHaveLength(180);
    expect(survivingIds("jinlong")).toHaveLength(242);
    // No area filter at all (the core's unrestricted input, which the app
    // never passes) is not the union of the two.
    expect(survivingIds()).toHaveLength(TOTAL_RECIPES);
  });

  it("lets no settlement's coupon exchanges survive the other settlement", () => {
    // The acceptance line, asserted as both prefixes rather than inferred from
    // the counts: a count can hold while the wrong 14 recipes are the ones cut.
    expect(
      survivingIds("tundra").filter((id) => id.startsWith("jinlong_coupon-")),
    ).toEqual([]);
    expect(
      survivingIds("jinlong").filter((id) => id.startsWith("tundra_coupon-")),
    ).toEqual([]);
    // Control: each settlement does keep its own, so the emptiness above is
    // the rule biting and not both families vanishing everywhere.
    expect(
      survivingIds("tundra").filter((id) => id.startsWith("tundra_coupon-")),
    ).toHaveLength(14);
    expect(
      survivingIds("jinlong").filter((id) => id.startsWith("jinlong_coupon-")),
    ).toHaveLength(14);
  });

  it("excludes a jinlong-tagged recipe sitting on an untagged machine", () => {
    // copper_nugget is tagged for jinlong; its furnace exists everywhere. Only
    // the recipe carrier can cut it.
    expect(survivingIds("tundra")).not.toContain("copper_nugget");
    expect(survivingIds("jinlong")).toContain("copper_nugget");
  });

  it("excludes an untagged recipe whose machines are all jinlong-only", () => {
    // liquid_plant_grass_1 carries no locations; both mix pools are jinlong.
    // Only the machine carrier can cut it.
    expect(survivingIds("tundra")).not.toContain("liquid_plant_grass_1");
    expect(survivingIds("jinlong")).toContain("liquid_plant_grass_1");
  });
});

describe("unavailableRecipeIds", () => {
  const idsFor = (
    pack: RecipePack,
    settings: AvailabilitySettings,
  ): ReadonlySet<string> =>
    unavailableRecipeIds(unavailableCauses(pack, settings));

  it("defaults to the off-cohort recipes only (fresh browser)", () => {
    // Pack cohort is v1.5: the v1.2 recipe is off, the v1.5 recipe and the
    // non-event recipe are on.
    expect(idsFor(fixturePack(), eventsOnly())).toEqual(new Set(["mint_coin"]));
  });

  it("includes the pack cohort's recipes when it is forced off", () => {
    expect(idsFor(fixturePack(), eventsOnly({ "v1.5": false }))).toEqual(
      new Set(["mint_coin", "grow_lung"]),
    );
  });

  it("excludes everything non-event and honors a forced-on off-cohort", () => {
    expect(
      idsFor(fixturePack(), eventsOnly({ "v1.2": true, "v1.5": true })),
    ).toEqual(new Set());
    // The non-event recipe never appears under any override map.
    expect(idsFor(fixturePack(), eventsOnly({ "v1.5": false }))).not.toContain(
      "smelt",
    );
  });
});

describe("availabilityKey", () => {
  it("changes when only a cause's kind changes", () => {
    const events = availabilityKey(
      unavailableCauses(fixturePack(), eventsOnly()),
    );
    const manual = availabilityKey(
      unavailableCauses(fixturePack(), {
        eventOverrides: { "v1.2": true },
        disabledRecipeIds: new Set(["mint_coin"]),
      }),
    );
    // Same single id under both, different reason.
    expect(events).not.toBe(manual);
  });

  it("is stable across two derivations of the same settings", () => {
    expect(
      availabilityKey(unavailableCauses(fixturePack(), eventsOnly())),
    ).toBe(availabilityKey(unavailableCauses(fixturePack(), eventsOnly())));
  });
});

describe("unavailableItems", () => {
  it("defaults to the off-cohort items only, each mapped to its cause", () => {
    // Pack cohort is v1.5: coin (v1.2) is off, and so is token_orphan (v1.1)
    // - the derivation is item-driven, so an item whose cohort carries no
    // recipe still surfaces with the cohort its tiles must name.
    expect(unavailableItems(fixturePack(), eventsOnly())).toEqual(
      new Map([
        ["coin", { kind: "event", cohort: "v1.2" }],
        ["token_orphan", { kind: "event", cohort: "v1.1" }],
      ]),
    );
  });

  it("follows overrides in both directions", () => {
    // v1.2 forced on drops its item; v1.5 forced off adds the pack cohort's;
    // untouched v1.1 keeps its default-off item.
    expect(
      unavailableItems(
        fixturePack(),
        eventsOnly({ "v1.2": true, "v1.5": false }),
      ),
    ).toEqual(
      new Map([
        ["lung", { kind: "event", cohort: "v1.5" }],
        ["token_orphan", { kind: "event", cohort: "v1.1" }],
      ]),
    );
  });

  it("maps an item whose every producer is out of area to that area", () => {
    // Under the tundra only mint_coin is out of area, and it is coin's single
    // producer; bar's producer (smelt) is tundra-tagged, so bar stays clear.
    const tundra = unavailableItems(locatedPack(), {
      eventOverrides: { "v1.2": true },
      area: "tundra",
    });
    expect(tundra.get("coin")).toEqual({ kind: "area", area: "tundra" });
    expect(tundra.has("bar")).toBe(false);

    // The mirror: under jinlong smelt is the recipe carrier that fails, so bar
    // is the item that goes dark.
    const jinlong = unavailableItems(locatedPack(), {
      eventOverrides: { "v1.2": true },
      area: "jinlong",
    });
    expect(jinlong.get("bar")).toEqual({ kind: "area", area: "jinlong" });
    expect(jinlong.has("coin")).toBe(false);
  });

  it("keeps an item whose producers disagree about the area", () => {
    const pack = locatedPack();
    const minter = pack.recipes.find((r) => r.id === "mint_coin")!;
    pack.recipes = [
      ...pack.recipes,
      { ...minter, id: "mint_coin_anywhere", producers: ["machine"] },
    ];
    // The second recipe runs on the untagged machine, so coin can still be
    // made in the tundra.
    expect(
      unavailableItems(pack, {
        eventOverrides: { "v1.2": true },
        area: "tundra",
      }).has("coin"),
    ).toBe(false);
  });

  it("maps a manually disabled sole producer onto its item", () => {
    expect(
      unavailableItems(fixturePack(), {
        eventOverrides: { "v1.2": true },
        disabledRecipeIds: new Set(["smelt"]),
      }).get("bar"),
    ).toEqual({ kind: "manual", recipeId: "smelt" });
  });

  it("lets an item's own cohort win over its producers' cause", () => {
    // coin is v1.2-tagged and off by default; under the tundra its only
    // producer is also out of area. The tile speaks of the item's cohort.
    expect(
      unavailableItems(locatedPack(), { eventOverrides: {}, area: "tundra" }),
    ).toEqual(
      new Map([
        ["coin", { kind: "event", cohort: "v1.2" }],
        ["token_orphan", { kind: "event", cohort: "v1.1" }],
      ]),
    );
  });

  it("never contains non-event items, under any override map", () => {
    const map = unavailableItems(fixturePack(), eventsOnly({ "v1.5": false }));
    expect(map.has("ore")).toBe(false);
    expect(map.has("bar")).toBe(false);
    // And every cohort on empties it entirely.
    expect(
      unavailableItems(
        fixturePack(),
        eventsOnly({ "v1.1": true, "v1.2": true }),
      ),
    ).toEqual(new Map());
  });
});

// The inputs seam: the same settings, the cohort pass alone. The target picker
// asks what can be MADE here, the inputs picker what can be BROUGHT IN, and an
// area or a hand toggle only answers the first question.
describe("unavailableEventItems", () => {
  const TUNDRA: AvailabilitySettings = {
    eventOverrides: { "v1.2": true },
    area: "tundra",
  };

  it("keeps the item's own cohort and drops the producer causes", () => {
    // coin's only tundra-legal producer is missing and smelt is off by hand:
    // both causes land in the target map and neither in this one.
    const settings: AvailabilitySettings = {
      ...TUNDRA,
      disabledRecipeIds: new Set(["smelt"]),
    };
    expect(unavailableItems(locatedPack(), settings)).toEqual(
      new Map([
        ["coin", { kind: "area", area: "tundra" }],
        ["bar", { kind: "manual", recipeId: "smelt" }],
        ["token_orphan", { kind: "event", cohort: "v1.1" }],
      ]),
    );
    expect(unavailableEventItems(locatedPack(), settings)).toEqual(
      new Map([["token_orphan", { kind: "event", cohort: "v1.1" }]]),
    );
  });

  it("leaves an area-blocked shipped item importable", () => {
    // The tundra with the pack's own cohort forced off, so both passes have
    // something to say over the pack we actually ship.
    const settings: AvailabilitySettings = {
      eventOverrides: { [packCohortOf(shippedPack)]: false },
      area: "tundra",
    };
    // copper_nugget is jinlong-tagged, so the tundra has no producer for it -
    // which is a reason to stop offering it as a target, not as an import.
    expect(
      unavailableItems(shippedPack, settings).get("copper_nugget"),
    ).toEqual({ kind: "area", area: "tundra" });
    const inputs = unavailableEventItems(shippedPack, settings);
    expect(inputs.has("copper_nugget")).toBe(false);
    // Nothing but a cohort can dim an input tile, whatever else is switched off.
    expect(inputs.size).toBeGreaterThan(0);
    expect(new Set([...inputs.values()].map((c) => c.kind))).toEqual(
      new Set(["event"]),
    );
  });
});

describe("stored overrides", () => {
  it("round-trips a written map", () => {
    writeStoredEventOverrides({ "v1.5": false, "v1.2": true });
    expect(readStoredEventOverrides()).toEqual({ "v1.5": false, "v1.2": true });
  });

  it("returns {} when nothing is stored", () => {
    expect(readStoredEventOverrides()).toEqual({});
  });

  it("survives malformed JSON", () => {
    window.localStorage.setItem(
      EVENT_COHORT_OVERRIDES_STORAGE_KEY,
      '{"v1.5": fal',
    );
    expect(readStoredEventOverrides()).toEqual({});
  });

  it("survives a non-object stored value", () => {
    for (const bad of ["null", "5", '"v1.5"', '["v1.5"]', "true"]) {
      window.localStorage.setItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY, bad);
      expect(readStoredEventOverrides()).toEqual({});
    }
  });

  it("drops non-boolean values and keeps the booleans", () => {
    window.localStorage.setItem(
      EVENT_COHORT_OVERRIDES_STORAGE_KEY,
      '{"v1.5": false, "v1.2": "yes", "v1.1": 1, "v1.0": null}',
    );
    expect(readStoredEventOverrides()).toEqual({ "v1.5": false });
  });
});

describe("stored area", () => {
  it("round-trips an area the pack lists", () => {
    writeStoredArea("tundra");
    expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBe("tundra");
    expect(readStoredArea(shippedPack)).toBe("tundra");
  });

  it("reads an absent key as the latest settlement without writing it", () => {
    expect(readStoredArea(shippedPack)).toBe("jinlong");
    expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBeNull();
  });

  it("falls back to the latest settlement for a value the pack does not list", () => {
    // Hand-edited storage, or an area a pack bump retired: filtering against
    // an area no machine names would hide every recipe behind an empty canvas.
    for (const bad of ["", "atlantis", "TUNDRA", "[]"]) {
      window.localStorage.setItem(AREA_STORAGE_KEY, bad);
      expect(readStoredArea(shippedPack)).toBe("jinlong");
    }
  });
});

describe("latestArea", () => {
  it("is the last settlement the pack lists", () => {
    expect(latestArea(shippedPack)).toBe("jinlong");
    const newer = {
      ...shippedPack,
      locations: [
        ...shippedPack.locations,
        { id: "newer", name: "newer", icon: "newer" },
      ],
    };
    expect(latestArea(newer)).toBe("newer");
  });
});
