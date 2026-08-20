import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Recipe } from "@aef/schema";

import { layoutRenderPlan } from "../../src/canvas/layout";
import { BETWEEN_LAYERS_SPACING } from "../../src/canvas/dimensions";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type {
  LoopBoxContainer,
  RenderPlan,
  RenderUnitRecipe,
} from "../../src/pipeline/types";

const mkRecipe = (id: string, ins: string[], outs: string[]): Recipe => ({
  id,
  name: id,
  category: "cat",
  icon: "ico",
  row: 0,
  time: 1,
  in: ins.map((item) => ({ item, qty: 1 })),
  out: outs.map((item) => ({ item, qty: 1 })),
  producers: [],
});

const mkRecipeUnit = (
  id: string,
  recipeId: string,
  containerId: string,
): RenderUnitRecipe => ({
  id,
  kind: "recipe",
  recipeId,
  count: 1,
  multiplicity: { num: "1", denom: "1" },
  containerId,
});

describe("loop-slab interior spacing", () => {
  it("gives slab members a full inter-layer corridor", async () => {
    // Two members of one loop-box slab, wired a -> b so ELK layers them
    // horizontally. The corridor between them has to hold a rate chip, so it
    // must be at least as wide as an open-layout corridor.
    const recipeA = mkRecipe("r:a", [], ["x"]);
    const recipeB = mkRecipe("r:b", ["x"], []);
    const container: LoopBoxContainer = {
      kind: "loop-box",
      id: "lc:1",
      members: ["u:a", "u:b"],
      sccId: "scc:1",
    };
    const plan: RenderPlan = {
      units: [
        mkRecipeUnit("u:a", "r:a", "lc:1"),
        mkRecipeUnit("u:b", "r:b", "lc:1"),
      ],
      edges: [
        {
          fromUnit: "u:a",
          toUnit: "u:b",
          item: "x",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [container],
    };
    const result = await layoutRenderPlan({
      plan,
      recipeById: new Map([
        ["r:a", recipeA],
        ["r:b", recipeB],
      ]),
      itemById: new Map(),
    });
    const members = result.nodes.filter(
      (n) => (n as { parentId?: string }).parentId === "lc:1",
    );
    expect(members.length).toBe(2);
    const [left, right] = [...members].sort(
      (a, b) => a.position.x - b.position.x,
    );
    // Recipe nodes carry their size only through measureRecipe (the RF node
    // itself has no width; only group nodes get one), so measure the left card
    // rather than reading a field that is undefined here.
    const leftWidth = measureRecipe(
      left!.id === "u:a" ? recipeA : recipeB,
    ).width;
    const gap = right!.position.x - (left!.position.x + leftWidth);
    expect(gap).toBeGreaterThanOrEqual(BETWEEN_LAYERS_SPACING);
  });
});
