import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { ffdPack } from "../../src/solver/ffd";
import { UnknownCarrierError, type Replica } from "../../src/solver/types";
import type { Item, Recipe } from "@aef/schema";
import type { TransportConfig } from "../../src/data/transport-config";

function rep(
  id: string,
  recipeId: string,
  groupId: string,
  rate: Fraction,
): Replica {
  return {
    id,
    recipeId,
    executionRate: rate,
    consumerPath: [],
    blueprintGroupId: groupId,
    sharedAtArticulation: false,
  };
}

function mkRecipe(id: string, outItem: string): Recipe {
  return {
    id,
    name: id,
    category: "x",
    icon: "x",
    row: 0,
    time: 1,
    in: [],
    out: [{ item: outItem, qty: 1 }],
    producers: ["m"],
  } as unknown as Recipe;
}

function mkItem(id: string, transportKind: string): Item {
  return {
    id,
    name: id,
    category: "x",
    icon: "x",
    row: 0,
    raw: false,
    transportKind,
  } as Item;
}

describe("ffdPack runtime UnknownCarrierError (B8)", () => {
  it("throws UnknownCarrierError naming both item and kind when transportKind has no carrier entry", () => {
    const items = new Map<string, Item>([
      ["phantom_item", mkItem("phantom_item", "phantom")],
    ]);
    const recipes = new Map<string, Recipe>([
      ["r1", mkRecipe("r1", "phantom_item")],
    ]);
    const tConfig: TransportConfig = {
      schemaVersion: "0.2",
      source: "test",
      lanesPerBlueprintGroup: 4,
      interGroupGapTiles: 2,
      carriers: {
        belt: { transportId: "belt", itemsPerSecondPerLane: 1 },
      },
    };
    let caught: unknown = null;
    try {
      ffdPack(
        [rep("a", "r1", "g1", new Fraction(1, 2))],
        items,
        recipes,
        tConfig,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownCarrierError);
    const err = caught as UnknownCarrierError;
    expect(err.kind).toBe("phantom");
    expect(err.itemId).toBe("phantom_item");
    expect(err.message).toBe(
      "unknown carrier kind 'phantom' for item 'phantom_item'",
    );
  });

  it("throws (not silently skips) when a recipe output item is missing from itemById", () => {
    // The output stream's item is not in itemById -- a pack referential-
    // integrity failure. Materialize throws in this case; ffdPack should be
    // consistent rather than silently producing an empty packing.
    const items = new Map<string, Item>();
    const recipes = new Map<string, Recipe>([
      ["r1", mkRecipe("r1", "missing_item")],
    ]);
    const tConfig: TransportConfig = {
      schemaVersion: "0.2",
      source: "test",
      lanesPerBlueprintGroup: 4,
      interGroupGapTiles: 2,
      carriers: { belt: { transportId: "belt", itemsPerSecondPerLane: 1 } },
    };
    expect(() =>
      ffdPack(
        [rep("a", "r1", "g1", new Fraction(1, 2))],
        items,
        recipes,
        tConfig,
      ),
    ).toThrow(/missing_item/);
  });

  it("packs without throwing when transportKind has a matching carrier entry", () => {
    const items = new Map<string, Item>([
      ["solid_a", mkItem("solid_a", "belt")],
    ]);
    const recipes = new Map<string, Recipe>([
      ["r1", mkRecipe("r1", "solid_a")],
    ]);
    const tConfig: TransportConfig = {
      schemaVersion: "0.2",
      source: "test",
      lanesPerBlueprintGroup: 4,
      interGroupGapTiles: 2,
      carriers: {
        belt: { transportId: "belt", itemsPerSecondPerLane: 1 },
      },
    };
    const lanes = ffdPack(
      [rep("a", "r1", "g1", new Fraction(1, 2))],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.carrier).toBe("belt");
  });
});
