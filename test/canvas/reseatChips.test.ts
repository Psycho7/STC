// reseatChips equals a fresh seating pass over stamp-free edges.
import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  deconflictChipAnchors,
  reseatChips,
} from "../../src/canvas/chipSeating";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  inputProductNode,
  mkEdge,
  mkRecipe,
  recipeNode,
} from "./busRouting.testkit";

// The default plan's ore + water pair into one refinery (see shortLegChips).
// Since the card trim moved the input rows up 20 units, BOTH chips hold
// full-reserve seats on their own lines at the corridor's window cap (107,
// between the taps' out-band edge 444 and the recipe's in-band edge 551, over
// the 87-unit natural "60/min" box): the ore chip's target-run seat rose with
// its row out of the water chip's reserve band, so the shrink tier no longer
// fires on either of the pair.
const pairFixture = (waterTapY: number) => {
  const recipe = mkRecipe("r", ["ore", "water"], ["out"]);
  const nodes: RFAnyNode[] = [
    recipeNode("r", 560, 29, recipe),
    inputProductNode("tapOre", "ore", 286, 19),
    inputProductNode("tapWater", "water", 286, waterTapY),
  ];
  const edges: Edge[] = [
    mkEdge("e:1:tapOre->r:ore", "tapOre", "r", "ore"),
    mkEdge("e:2:tapWater->r:water", "tapWater", "r", "water"),
  ];
  Object.assign(edges[0]!.data!, { bendX: 486.67, chamferBudget: 5.17 });
  Object.assign(edges[1]!.data!, { bendX: 517.67, chamferBudget: 5.17 });
  return { nodes, edges };
};

const dataOf = (edges: Edge[], id: string) =>
  edges.find((e) => e.id === id)!.data as Record<string, unknown>;

describe("reseatChips", () => {
  it("re-seats from clean edges after a node moves, leaving no stale stamp", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    // Premise: both chips of the pair seat on the full pass at the corridor's
    // window cap. The trim's 20-unit row lift moved the ore chip's target-run
    // seat off the water chip's reserve (the two boxes used to overlap by 5
    // units, which shoved the ore chip onto the shrink pass at cap 1; they
    // now clear by 13), so the cap that binds BOTH is the window's.
    expect(dataOf(laid, "e:1:tapOre->r:ore").chipScaleCap).toBeCloseTo(
      107 / 87,
      5,
    );
    expect(dataOf(laid, "e:2:tapWater->r:water").chipScaleCap).toBeCloseTo(
      107 / 87,
      5,
    );

    // The water tap is dragged 300 units down: its leg is now a long dogleg
    // clear of the ore chip, so neither seat depends on the other any more
    // and the re-seated caps equal a fresh pass over the moved nodes -- still
    // the corridor's window cap, because the corridor between the same two
    // cards is as wide as before.
    const moved: RFAnyNode[] = nodes.map((n) =>
      n.id === "tapWater" ? { ...n, position: { x: 286, y: 427 } } : n,
    );
    const reseated = reseatChips(moved, laid);
    const fresh = deconflictChipAnchors(moved, pairFixture(427).edges);
    expect(reseated.map((e) => e.data)).toEqual(fresh.map((e) => e.data));
    for (const id of ["e:1:tapOre->r:ore", "e:2:tapWater->r:water"]) {
      expect(dataOf(reseated, id).chipScaleCap).toBeCloseTo(107 / 87, 5);
    }
  });

  it("is a no-op re-run when nothing moved", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    const again = reseatChips(nodes, laid);
    expect(again.map((e) => e.data)).toEqual(laid.map((e) => e.data));
  });
});
