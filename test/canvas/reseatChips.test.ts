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

// The default plan's ore + water pair into one refinery (see shortLegChips):
// the tightest corridor the plan produces, where both chips have to find a seat
// on their own line.
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
    // Premise: the layout-time seat moved at least one of the pair off its
    // anchor, so there is a stamp that can go stale.
    expect(dataOf(laid, "e:1:tapOre->r:ore").labelDx).not.toBeUndefined();

    // The water tap is dragged 300 units down: its leg is now a long dogleg
    // clear of the ore chip, so every stamp must be recomputed from the moved
    // geometry rather than carried over.
    const moved: RFAnyNode[] = nodes.map((n) =>
      n.id === "tapWater" ? { ...n, position: { x: 286, y: 427 } } : n,
    );
    const reseated = reseatChips(moved, laid);
    const fresh = deconflictChipAnchors(moved, pairFixture(427).edges);
    expect(reseated.map((e) => e.data)).toEqual(fresh.map((e) => e.data));
  });

  it("is a no-op re-run when nothing moved", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    const again = reseatChips(nodes, laid);
    expect(again.map((e) => e.data)).toEqual(laid.map((e) => e.data));
  });
});
