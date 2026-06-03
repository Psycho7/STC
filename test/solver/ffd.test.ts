import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { ffdPack } from "../../src/solver/ffd";
import type { Replica } from "../../src/solver/types";
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

const tConfig: TransportConfig = {
  schemaVersion: "0.1",
  source: "test",
  lanesPerBlueprintGroup: 2,
  interGroupGapTiles: 2,
  carriers: {
    belt: { transportId: "belt", itemsPerSecondPerLane: 1 },
    pipe: { transportId: "pipe", itemsPerSecondPerLane: 4 },
  },
};

const items = new Map<string, Item>([
  [
    "solid_a",
    {
      id: "solid_a",
      name: "solid_a",
      stack: 50,
      category: "x",
      icon: "x",
      row: 0,
      raw: false,
      transportKind: "belt",
    } as Item,
  ],
  [
    "solid_b",
    {
      id: "solid_b",
      name: "solid_b",
      stack: 50,
      category: "x",
      icon: "x",
      row: 0,
      raw: false,
      transportKind: "belt",
    } as Item,
  ],
  [
    "fluid_a",
    {
      id: "fluid_a",
      name: "fluid_a",
      category: "x",
      icon: "x",
      row: 0,
      raw: false,
      transportKind: "pipe",
    } as Item,
  ],
]);

const recipeSolidA = {
  id: "rs1",
  in: [],
  out: [{ item: "solid_a", qty: 1 }],
  producers: ["m"],
  time: 1,
} as unknown as Recipe;
const recipeSolidB = {
  id: "rs2",
  in: [],
  out: [{ item: "solid_b", qty: 1 }],
  producers: ["m"],
  time: 1,
} as unknown as Recipe;
const recipeSink = {
  id: "rsink",
  in: [{ item: "solid_a", qty: 1 }],
  out: [],
  producers: ["m"],
  time: 1,
} as unknown as Recipe;
const recipeFluid = {
  id: "rf1",
  in: [],
  out: [{ item: "fluid_a", qty: 1 }],
  producers: ["m"],
  time: 1,
} as unknown as Recipe;

const recipes = new Map<string, Recipe>([
  ["rs1", recipeSolidA],
  ["rs2", recipeSolidB],
  ["rsink", recipeSink],
  ["rf1", recipeFluid],
]);

describe("ffdPack", () => {
  it("empty replicas produces empty lanes", () => {
    expect(ffdPack([], items, recipes, tConfig)).toEqual([]);
  });

  it("single stream fits on one lane", () => {
    const lanes = ffdPack(
      [rep("a", "rs1", "g1", new Fraction(1, 2))],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.streams.length).toBe(1);
    expect(lanes[0]!.carrier).toBe("belt");
    expect(lanes[0]!.overflow).toBe(false);
  });

  it("two small streams fit on the same lane (FFD)", () => {
    const lanes = ffdPack(
      [
        rep("a", "rs1", "g1", new Fraction(1, 2)),
        rep("b", "rs1", "g1", new Fraction(1, 4)),
      ],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.streams.length).toBe(2);
  });

  it("streams larger than one lane overflow into a new lane within budget", () => {
    const lanes = ffdPack(
      [
        rep("a", "rs1", "g1", new Fraction(3, 4)),
        rep("b", "rs1", "g1", new Fraction(3, 4)),
      ],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(2);
    for (const l of lanes) expect(l.overflow).toBe(false);
  });

  it("exceeding lane budget opens overflow lane", () => {
    const lanes = ffdPack(
      [
        rep("a", "rs1", "g1", new Fraction(3, 4)),
        rep("b", "rs1", "g1", new Fraction(3, 4)),
        rep("c", "rs1", "g1", new Fraction(3, 4)),
      ],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(3);
    expect(lanes.filter((l) => l.overflow).length).toBe(1);
  });

  it("single stream exceeding lane capacity emits a dedicated overflow lane (no throw)", () => {
    const lanes = ffdPack(
      [rep("big", "rs1", "g1", new Fraction(2))], // > 1 (belt cap)
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.overflow).toBe(true);
    expect(lanes[0]!.streams.length).toBe(1);
    expect(lanes[0]!.streams[0]!.itemsPerSec.equals(new Fraction(2))).toBe(
      true,
    );
  });

  it("sinks produce no streams", () => {
    const lanes = ffdPack(
      [rep("s", "rsink", "g1", new Fraction(5))],
      items,
      recipes,
      tConfig,
    );
    expect(lanes).toEqual([]);
  });

  it("fluids route to pipe carrier", () => {
    const lanes = ffdPack(
      [rep("f", "rf1", "g1", new Fraction(2))],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.carrier).toBe("pipe");
  });

  it("different blueprint groups produce separate lane sets", () => {
    const lanes = ffdPack(
      [
        rep("a", "rs1", "g1", new Fraction(1, 2)),
        rep("b", "rs1", "g2", new Fraction(1, 2)),
      ],
      items,
      recipes,
      tConfig,
    );
    expect(lanes.length).toBe(2);
    expect(new Set(lanes.map((l) => l.groupId))).toEqual(new Set(["g1", "g2"]));
  });
});
