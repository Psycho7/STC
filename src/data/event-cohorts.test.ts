// @vitest-environment jsdom
//
// The cohort model (#144): the effective-state rule (override wins in both
// directions; absent one, on iff the cohort matches the pack's own version),
// the unavailable-id derivation that feeds the availability seam, pack-cohort
// truncation from provenance, and the localStorage read/write pair - whose
// read side must survive any malformed stored value, since the key is
// attacker-controllable browser state.
import { afterEach, describe, expect, it } from "vitest";
import type { Item, Recipe, RecipePack, Stoich } from "@aef/schema";
import {
  effectiveCohortEnabled,
  eventCohortsOf,
  packCohortOf,
  readStoredEventOverrides,
  unavailableEventItems,
  unavailableRecipeIds,
  writeStoredEventOverrides,
} from "./event-cohorts";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./storage-keys";

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

describe("unavailableRecipeIds", () => {
  it("defaults to the off-cohort recipes only (fresh browser)", () => {
    // Pack cohort is v1.5: the v1.2 recipe is off, the v1.5 recipe and the
    // non-event recipe are on.
    expect(unavailableRecipeIds(fixturePack(), {})).toEqual(
      new Set(["mint_coin"]),
    );
  });

  it("includes the pack cohort's recipes when it is forced off", () => {
    expect(unavailableRecipeIds(fixturePack(), { "v1.5": false })).toEqual(
      new Set(["mint_coin", "grow_lung"]),
    );
  });

  it("excludes everything non-event and honors a forced-on off-cohort", () => {
    expect(
      unavailableRecipeIds(fixturePack(), { "v1.2": true, "v1.5": true }),
    ).toEqual(new Set());
    // The non-event recipe never appears under any override map.
    expect(
      unavailableRecipeIds(fixturePack(), { "v1.5": false }),
    ).not.toContain("smelt");
  });
});

describe("unavailableEventItems", () => {
  it("defaults to the off-cohort items only, each mapped to its cohort", () => {
    // Pack cohort is v1.5: coin (v1.2) is off, and so is token_orphan (v1.1)
    // - the derivation is item-driven, so an item whose cohort carries no
    // recipe still surfaces with the cohort its tiles must name.
    expect(unavailableEventItems(fixturePack(), {})).toEqual(
      new Map([
        ["coin", "v1.2"],
        ["token_orphan", "v1.1"],
      ]),
    );
  });

  it("follows overrides in both directions", () => {
    // v1.2 forced on drops its item; v1.5 forced off adds the pack cohort's;
    // untouched v1.1 keeps its default-off item.
    expect(
      unavailableEventItems(fixturePack(), { "v1.2": true, "v1.5": false }),
    ).toEqual(
      new Map([
        ["lung", "v1.5"],
        ["token_orphan", "v1.1"],
      ]),
    );
  });

  it("never contains non-event items, under any override map", () => {
    const map = unavailableEventItems(fixturePack(), { "v1.5": false });
    expect(map.has("ore")).toBe(false);
    expect(map.has("bar")).toBe(false);
    // And every cohort on empties it entirely.
    expect(
      unavailableEventItems(fixturePack(), { "v1.1": true, "v1.2": true }),
    ).toEqual(new Map());
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
